import 'jsr:@supabase/functions-js@2/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  base64urlToBytes,
  buildReply,
  cardText,
  clip,
  decodeEntities,
  describeMute,
  type Email,
  emailKeyboard,
  esc,
  fmtDate,
  gmailLink,
  isMuted,
  matchRules,
  muteEntry,
  parseRules,
  preview,
  readableBody,
  readEmail,
  refFromEntities,
  shouldSkip,
  similarWords,
  stopKeyboard,
  type Attachment,
  type Button,
} from './mail.ts'

/**
 * Mail bot: posts new mail from every connected inbox to one Telegram chat and
 * acts on it from there. Each email arrives as a short card ("Sender → inbox",
 * the subject, the first lines); ▾ More shows the rest, 🗑 removes it from the
 * chat, 🔕 stops emails like it. Each inbox connects with Google sign-in;
 * nothing is forwarded anywhere.
 *
 * Routes. verify_jwt is off because Telegram and Google call in without a
 * Supabase JWT, so every route checks its own secret:
 *   POST /telegram  Telegram webhook, checked against X-Telegram-Bot-Api-Secret-Token
 *   GET  /connect   short link from /connect that redirects to Google's consent screen
 *   GET  /callback  Google's OAuth redirect
 *   POST /cron      pg_cron: {} once a minute, {"job":"digest"} once a day
 *   GET  /health    public liveness, counts only
 *
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are the project secrets the
 * google-calendar function already uses. The Google Cloud project needs the
 * Gmail API enabled and REDIRECT_URI added to that OAuth client.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''

const FN_URL = `${SUPABASE_URL}/functions/v1/mail-bot`
const REDIRECT_URI = `${FN_URL}/callback`
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
const SCOPES = `openid email ${GMAIL_SCOPE}`
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/'
const REPLY_HEADERS = ['From', 'Reply-To', 'To', 'Cc', 'Subject', 'Message-ID', 'References']
  .map((h) => 'metadataHeaders=' + h).join('&')

const SKIP_CATEGORIES = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL']
const SKIP_QUERY = '-category:promotions -category:social'
const CARD_CHARS = 300
const PREVIEW_CHARS = 1200
const FULL_CHARS = 3300
const MAX_EMAILS_PER_RUN = 15
const MAX_ATTACHMENTS = 10
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const EXPIRY_MARGIN_MS = 60_000
const DEFAULT_TIME_ZONE = 'Asia/Bishkek'
const FILTER_WAIT_MS = 10 * 60_000
const DIGEST_ITEMS = 20

/** A 🗑 button for messages that are not email cards (files, lists, confirmations). */
const TRASH = { inline_keyboard: [[{ text: '🗑', callback_data: 'X' }]] }

const HELP = [
  '<b>Commands</b>',
  '/connect: add an inbox (sign in with Google)',
  '/inboxes: connected inboxes',
  '/disconnect name@company.com: remove an inbox',
  '/unread: latest unread emails',
  '/filter: only get emails with certain words (payment, erbol, payment + insurance)',
  '/skipped: emails your filters held back',
  '/muted: what you stopped with 🔕, tap to undo',
  '/check: check all inboxes now',
  '/pause, /resume: stop or restart notifications',
  '/status: is everything working',
  '',
  'On an email: ▾ More shows the rest, 🗑 removes it from this chat (it stays in Gmail), 🔕 stops emails like it.',
  'To answer an email, use Telegram\'s Reply on it and type your answer. I show you the reply before it goes out.',
].join('\n')

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

type Config = Record<string, string>
type View = 'min' | 'more' | 'full'

interface Inbox {
  id: number
  email: string
  label: string | null
  access_token: string | null
  access_token_expires_at: string | null
  history_id: string | null
  status: string
  last_error: string | null
  keywords: string[]
}

// ---------------------------------------------------------------- helpers --

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** supabase.co serves function HTML as plain text, so the browser pages are plain text. */
function page(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Keeps work running after the response is sent. */
function background(work: Promise<unknown>): void {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
  runtime?.waitUntil?.(work)
}

function randomToken(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The id_token arrives over TLS straight from Google, so the claims are read, not verified. */
function idTokenEmail(idToken: string | undefined): string {
  const payload = idToken?.split('.')[1]
  if (!payload) return ''
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    return String(JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))).email ?? '').toLowerCase()
  } catch {
    return ''
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function loadConfig(): Promise<Config> {
  const { data, error } = await db.from('mailbot_config').select('key, value')
  if (error) throw new Error('config: ' + error.message)
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]))
}

async function setConfig(key: string, value: string): Promise<void> {
  await db.from('mailbot_config').upsert({ key, value })
}

async function loadMuted(): Promise<string[]> {
  const { data } = await db.from('mailbot_muted').select('entry')
  return (data ?? []).map((r) => r.entry)
}

async function connectedInboxes(): Promise<Inbox[]> {
  const { data } = await db.from('mailbot_inboxes').select('*').eq('status', 'connected').order('id')
  return (data ?? []) as Inbox[]
}

async function inboxById(id: number): Promise<Inbox> {
  const { data } = await db.from('mailbot_inboxes').select('*').eq('id', id).maybeSingle()
  if (!data) throw new Error('that inbox is no longer connected')
  return data as Inbox
}

// --------------------------------------------------------------- telegram --

let botToken = ''

// deno-lint-ignore no-explicit-any
type TgResult = { ok: boolean; result?: any; description?: string; error_code?: number; parameters?: { retry_after?: number } }

async function tg(method: string, payload: Record<string, unknown> | FormData): Promise<TgResult> {
  if (!botToken) {
    const { data } = await db.rpc('mailbot_bot_token')
    botToken = data ?? ''
  }
  const init: RequestInit = payload instanceof FormData
    ? { method: 'POST', body: payload }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  for (let attempt = 0; ; attempt++) {
    let body: TgResult
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, init)
      body = await res.json()
    } catch (e) {
      if (attempt < 2) {
        await sleep(1000)
        continue
      }
      body = { ok: false, description: errorText(e) }
    }
    if (body.error_code === 429 && attempt < 2) {
      await sleep(Math.min(body.parameters?.retry_after ?? 1, 10) * 1000)
      continue
    }
    // "message is not modified" just means a button was tapped twice.
    if (!body.ok && !/not modified/i.test(body.description ?? '')) console.error('telegram', method, body.description)
    return body
  }
}

async function send(chat: string, text: string, markup?: unknown, replyTo?: number): Promise<TgResult> {
  const payload: Record<string, unknown> = {
    chat_id: chat,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  }
  if (markup) payload.reply_markup = markup
  if (replyTo) payload.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true }
  let res = await tg('sendMessage', payload)
  if (!res.ok && /parse entities/i.test(res.description ?? '')) {
    payload.text = decodeEntities(text.replace(/<[^>]+>/g, ''))
    delete payload.parse_mode
    res = await tg('sendMessage', payload)
  }
  return res
}

async function edit(chat: string | number, messageId: number, text: string, markup?: unknown): Promise<TgResult> {
  return await tg('editMessageText', {
    chat_id: chat,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: markup ?? { inline_keyboard: [] },
  })
}

/**
 * Telegram lets bots delete messages for 48 hours. After that a text message
 * is shrunk to "✓"; a file can't be shrunk, so it just loses its buttons.
 */
async function remove(chat: string | number, messageId: number): Promise<void> {
  if ((await tg('deleteMessage', { chat_id: chat, message_id: messageId })).ok) return
  if ((await edit(chat, messageId, '✓')).ok) return
  await tg('editMessageReplyMarkup', { chat_id: chat, message_id: messageId, reply_markup: { inline_keyboard: [] } })
}

/** A Telegram refusal that retrying won't fix (bad request) versus one worth another try. */
class TelegramError extends Error {
  transient: boolean
  constructor(res: TgResult) {
    super('telegram: ' + (res.description ?? 'error'))
    this.transient = res.error_code !== 400
  }
}

// ------------------------------------------------------------------ gmail --

class GmailError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  id_token?: string
  error?: string
  error_description?: string
}

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  return await res.json()
}

/**
 * A usable access token, refreshed only inside the expiry margin. invalid_grant
 * is terminal (access revoked, password changed): the inbox is flagged and the
 * owner told once, because only a new sign-in fixes it.
 */
async function accessToken(ib: Inbox, chat?: string): Promise<string> {
  if (ib.access_token && ib.access_token_expires_at &&
    Date.parse(ib.access_token_expires_at) > Date.now() + EXPIRY_MARGIN_MS) {
    return ib.access_token
  }
  const { data: refresh } = await db.rpc('mailbot_read_refresh_token', { p_inbox_id: ib.id })
  if (!refresh) throw new Error('no refresh token stored for ' + ib.email)
  const t = await postToken({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refresh,
    grant_type: 'refresh_token',
  })
  if (!t.access_token) {
    if (t.error === 'invalid_grant') {
      await db.from('mailbot_inboxes').update({ status: 'needs_reauth', last_error: t.error_description ?? t.error })
        .eq('id', ib.id)
      ib.status = 'needs_reauth'
      if (chat) {
        await send(chat, '⚠️ Google signed out <b>' + esc(ib.email) + '</b> (access removed or password changed). ' +
          'Send /connect to sign it in again.')
      }
    }
    throw new Error('token refresh failed for ' + ib.email + ': ' + (t.error ?? 'unknown'))
  }
  ib.access_token = t.access_token
  ib.access_token_expires_at = new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString()
  await db.from('mailbot_inboxes')
    .update({ access_token: ib.access_token, access_token_expires_at: ib.access_token_expires_at })
    .eq('id', ib.id)
  return ib.access_token
}

// deno-lint-ignore no-explicit-any
async function gmail(ib: Inbox, path: string, body?: unknown, chat?: string): Promise<any> {
  const token = await accessToken(ib, chat)
  const res = await fetch(GMAIL + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300)
    throw new GmailError(res.status, `Gmail ${path.split('?')[0]}: ${res.status} ${detail}`)
  }
  return res.status === 204 ? {} : await res.json()
}

async function fetchEmail(ib: Inbox, id: string): Promise<Email> {
  return readEmail(await gmail(ib, `messages/${id}?format=full`))
}

// ---------------------------------------------------------------- polling --

async function pollAll(cfg: Config): Promise<number> {
  const chat = cfg.owner_chat_id
  const tz = cfg.time_zone || DEFAULT_TIME_ZONE
  const muted = await loadMuted()
  const counts = await Promise.all((await connectedInboxes()).map(async (ib) => {
    try {
      return await pollInbox(ib, chat, muted, tz)
    } catch (e) {
      console.error('poll', ib.email, e)
      const message = errorText(e).slice(0, 500)
      await db.from('mailbot_inboxes').update({ last_error: message, last_checked_at: new Date().toISOString() })
        .eq('id', ib.id)
      // Told once when an inbox starts failing; /status shows it until it recovers.
      if (!ib.last_error && ib.status === 'connected') {
        await send(chat, '⚠️ Couldn\'t check <b>' + esc(ib.email) + '</b>: ' + esc(message), TRASH)
      }
      return 0
    }
  }))
  if (Math.random() < 1 / 60) {
    await db.from('mailbot_seen').delete().lt('seen_at', new Date(Date.now() - 14 * 86_400_000).toISOString())
    await db.from('mailbot_skipped').delete().lt('received_at', new Date(Date.now() - 7 * 86_400_000).toISOString())
  }
  return counts.reduce((a, b) => a + b, 0)
}

/**
 * Posts what arrived since the inbox's history cursor. Gmail's history API
 * lists only additions, so a quiet inbox costs one small call a minute.
 */
async function pollInbox(ib: Inbox, chat: string, muted: string[], tz: string): Promise<number> {
  const now = new Date().toISOString()
  if (!ib.history_id) {
    const profile = await gmail(ib, 'profile', undefined, chat)
    await db.from('mailbot_inboxes').update({ history_id: String(profile.historyId), last_checked_at: now, last_error: null })
      .eq('id', ib.id)
    return 0
  }

  const ids: string[] = []
  let latest = ib.history_id
  let pageToken = ''
  do {
    const q = new URLSearchParams({ startHistoryId: ib.history_id, historyTypes: 'messageAdded', labelId: 'INBOX' })
    if (pageToken) q.set('pageToken', pageToken)
    let body
    try {
      body = await gmail(ib, 'history?' + q, undefined, chat)
    } catch (e) {
      // 404: the cursor aged out (Gmail keeps about a week). Start again from now.
      if (e instanceof GmailError && e.status === 404) {
        ib.history_id = null
        return await pollInbox(ib, chat, muted, tz)
      }
      throw e
    }
    for (const h of body.history ?? []) {
      for (const added of h.messagesAdded ?? []) {
        const m = added.message
        if (!shouldSkip(m.labelIds ?? [], SKIP_CATEGORIES) && !ids.includes(m.id)) ids.push(m.id)
      }
    }
    if (body.historyId) latest = String(body.historyId)
    pageToken = body.nextPageToken ?? ''
  } while (pageToken)

  const batch = ids.slice(0, MAX_EMAILS_PER_RUN)
  let posted = 0
  let retry = false
  if (batch.length) {
    // Claim before posting, so overlapping runs never post the same email twice.
    const { data: claimed } = await db.from('mailbot_seen')
      .upsert(batch.map((id) => ({ inbox_id: ib.id, message_id: id })), {
        onConflict: 'inbox_id,message_id',
        ignoreDuplicates: true,
      })
      .select('message_id')
    const mine = new Set((claimed ?? []).map((r) => r.message_id))
    for (const id of batch) {
      if (!mine.has(id)) continue
      try {
        if (await deliver(ib, id, chat, muted, tz)) posted++
      } catch (e) {
        if (e instanceof GmailError && e.status === 404) continue // deleted before we got to it
        console.error('deliver', ib.email, id, e)
        if (e instanceof TelegramError && !e.transient) continue
        retry = true
        await db.from('mailbot_seen').delete().eq('inbox_id', ib.id).eq('message_id', id)
      }
    }
  }

  // A capped or failed run keeps the cursor, so the rest comes next minute;
  // mailbot_seen skips whatever was already posted.
  const update: Record<string, unknown> = { last_checked_at: now, last_error: null }
  if (!retry && ids.length <= batch.length) update.history_id = latest
  await db.from('mailbot_inboxes').update(update).eq('id', ib.id)
  return posted
}

async function deliver(ib: Inbox, id: string, chat: string, muted: string[], tz: string): Promise<boolean> {
  const email = readEmail(await gmail(ib, `messages/${id}?format=full`, undefined, chat))
  if (shouldSkip(email.labelIds, SKIP_CATEGORIES)) return false
  if (email.from.email === ib.email) return false // mail you sent to yourself
  if (isMuted(muted, email.from.email, email.subject)) return false
  if (!matchRules(email, ib.keywords).pass) {
    // Held back, not lost: the daily digest and /skipped list these.
    await db.from('mailbot_skipped').upsert({
      inbox_id: ib.id,
      message_id: email.id,
      sender: email.from.label,
      subject: email.subject,
      received_at: email.date.toISOString(),
    })
    return false
  }
  await postCard(ib, email, chat, tz, 'min')
  return true
}

// ------------------------------------------------------------------ cards --

function cardFor(ib: Inbox, email: Email, tz: string, view: View): string {
  const base = { inbox: ib.label || ib.email, email, link: gmailLink(ib.email, email.id), timeZone: tz }
  if (view === 'min') return cardText({ ...base, body: preview(email, CARD_CHARS) })
  const tags = matchRules(email, ib.keywords).tags
  if (view === 'more') {
    return cardText({ ...base, details: true, tags, body: clip(readableBody(email, true), PREVIEW_CHARS) })
  }
  const full = readableBody(email, false)
  const body = full.length > FULL_CHARS ? clip(full, FULL_CHARS) + '\n\n(the rest is in Gmail: ↗ Gmail)' : full
  return cardText({ ...base, details: true, tags, body })
}

function cardButtons(ib: Inbox, email: Email, view: View): { inline_keyboard: Button[][] } {
  return emailKeyboard(ib.id, email.id, gmailLink(ib.email, email.id), view,
    Math.min(email.attachments.length, MAX_ATTACHMENTS))
}

async function postCard(ib: Inbox, email: Email, chat: string, tz: string, view: View): Promise<void> {
  const res = await send(chat, cardFor(ib, email, tz, view), cardButtons(ib, email, view))
  if (!res.ok) throw new TelegramError(res)
}

// deno-lint-ignore no-explicit-any
async function showCard(q: any, ib: Inbox, id: string, view: View, cfg: Config): Promise<void> {
  const email = await fetchEmail(ib, id)
  await edit(q.message.chat.id, q.message.message_id, cardFor(ib, email, cfg.time_zone || DEFAULT_TIME_ZONE, view),
    cardButtons(ib, email, view))
}

/** 📎: the files of one email, each as a document with its own 🗑. */
async function sendFiles(chat: string, ib: Inbox, id: string, replyTo: number): Promise<void> {
  const email = await fetchEmail(ib, id)
  const link = gmailLink(ib.email, email.id)
  for (const file of email.attachments.slice(0, MAX_ATTACHMENTS)) {
    try {
      await sendAttachment(ib, email, file, link, chat, replyTo)
    } catch (e) {
      console.error('attachment', file.name, e)
      await send(chat, '📎 Couldn\'t send ' + esc(file.name) + '. <a href="' + esc(link) + '">Open in Gmail</a>',
        TRASH, replyTo)
    }
  }
}

async function sendAttachment(ib: Inbox, email: Email, file: Attachment, link: string, chat: string, replyTo: number) {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    await send(chat, '📎 ' + esc(file.name) + ' is ' + Math.round(file.size / 1048576) + ' MB, too big for Telegram. ' +
      '<a href="' + esc(link) + '">Open in Gmail</a>', TRASH, replyTo)
    return
  }
  const data = file.data ?? (await gmail(ib, `messages/${email.id}/attachments/${file.attachmentId}`)).data
  const form = new FormData()
  form.set('chat_id', chat)
  form.set('document', new Blob([base64urlToBytes(data)], { type: file.mimeType }), file.name)
  // The caption link lets you reply to a file just like to its email.
  form.set('caption', '📎 <a href="' + esc(link) + '">' + esc(file.name) + '</a>')
  form.set('parse_mode', 'HTML')
  form.set('reply_parameters', JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }))
  form.set('reply_markup', JSON.stringify(TRASH))
  const res = await tg('sendDocument', form)
  if (!res.ok) throw new TelegramError(res)
}

// ---------------------------------------------------------------- updates --

// deno-lint-ignore no-explicit-any
async function onUpdate(cfg: Config, u: any): Promise<void> {
  const owner = cfg.owner_chat_id ?? ''
  if (u.callback_query) {
    const q = u.callback_query
    if (owner && String(q.message?.chat?.id) === owner) await onCallback(cfg, q)
    return
  }
  const m = u.message
  if (!m || m.chat?.type !== 'private') return
  const chat = String(m.chat.id)
  const text = String(m.text ?? m.caption ?? '').trim()

  if (!owner) {
    // Pairing: only the /start link with the code from mailbot_config claims the bot.
    const code = text.match(/^\/start\s+(\S+)/)?.[1]
    if (code && cfg.pair_code && code === cfg.pair_code) {
      await setConfig('owner_chat_id', chat)
      await db.from('mailbot_config').delete().eq('key', 'pair_code')
      await send(chat, '✅ This bot is yours now.\n\nAdd your inboxes: send /connect, sign in to one inbox, ' +
        'and repeat for each of them.\n\n' + HELP)
    }
    return
  }
  if (chat !== owner) return

  if (cfg.awaiting_filter && m.reply_to_message) await db.from('mailbot_config').delete().eq('key', 'awaiting_filter')
  if (text.startsWith('/')) await onCommand(cfg, chat, text)
  else if (m.reply_to_message) await onReply(chat, m, text)
  else if (!(await applyAwaitedFilter(cfg, chat, text))) {
    await send(chat, 'To answer an email, use Telegram\'s Reply on it. /help lists the commands.', TRASH)
  }
}

async function onCommand(cfg: Config, chat: string, text: string): Promise<void> {
  const [first, ...rest] = text.split(/\s+/)
  const cmd = first.toLowerCase().replace(/@\w+$/, '')
  const arg = rest.join(' ').trim()
  // Any command cancels a pending "type your words" from /filter.
  if (cfg.awaiting_filter) await db.from('mailbot_config').delete().eq('key', 'awaiting_filter')
  switch (cmd) {
    case '/connect':
      return await cmdConnect(chat, arg)
    case '/inboxes':
      return await cmdInboxes(chat)
    case '/disconnect':
      return await cmdDisconnect(chat, arg)
    case '/unread':
      return await cmdUnread(cfg, chat)
    case '/filter':
      return await cmdFilter(chat, arg)
    case '/skipped':
      return await sendDigest(cfg, chat, false)
    case '/check': {
      if (cfg.paused === 'true') {
        await send(chat, '⏸ Paused. /resume first.')
        return
      }
      if (!(await pollAll(cfg))) await send(chat, '📭 Nothing new.', TRASH)
      return
    }
    case '/mute':
      return await cmdMute(chat, arg, true)
    case '/unmute':
      return await cmdMute(chat, arg, false)
    case '/muted':
      return await cmdMuted(chat)
    case '/pause':
      await setConfig('paused', 'true')
      await send(chat, '⏸ Paused. /resume turns emails back on.', TRASH)
      return
    case '/resume':
      await setConfig('paused', 'false')
      // Fresh cursors: what arrived while paused is skipped, not dumped into the chat at once.
      await db.from('mailbot_inboxes').update({ history_id: null }).eq('status', 'connected')
      await send(chat, '▶️ Back on. /unread shows what came in while paused.', TRASH)
      return
    case '/status':
      return await cmdStatus(cfg, chat)
    default:
      await send(chat, HELP, TRASH)
  }
}

async function cmdConnect(chat: string, hint: string): Promise<void> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    await send(chat, 'Google sign-in isn\'t set up on the server (GOOGLE_CLIENT_ID is missing).')
    return
  }
  const state = randomToken(18)
  await db.from('mailbot_oauth_states').insert({ state, code_verifier: randomToken(48), login_hint: hint || null })
  await db.from('mailbot_oauth_states').delete().lt('expires_at', new Date().toISOString())
  const link = `${FN_URL}/connect?s=${state}`
  await send(chat, '🔐 Tap the button, sign in to the inbox you want to add, and allow access.\n\n' +
    'If Google won\'t open inside Telegram, copy this link into Safari or Chrome:\n' + esc(link) +
    '\n\nThe link works once, for 15 minutes.', {
    inline_keyboard: [[{ text: '🔐 Sign in with Google', url: link }]],
  })
}

async function cmdInboxes(chat: string): Promise<void> {
  const { data } = await db.from('mailbot_inboxes').select('email, status, last_error, keywords').order('id')
  if (!data?.length) {
    await send(chat, 'No inboxes yet. Send /connect to add one.')
    return
  }
  const lines = data.map((r) =>
    (r.status !== 'connected'
      ? '⚠️ ' + esc(r.email) + ': signed out, /connect it again'
      : (r.last_error ? '⚠️ ' : '✅ ') + esc(r.email) + (r.last_error ? ': ' + esc(clip(r.last_error, 120)) : '')) +
    ' · 🏷 ' + esc(describeFilter(r as Inbox))
  )
  lines.push('', '/connect adds another. /disconnect name@company.com removes one.')
  await send(chat, lines.join('\n'), TRASH)
}

async function cmdDisconnect(chat: string, arg: string): Promise<void> {
  const email = arg.toLowerCase()
  const { data: ib } = await db.from('mailbot_inboxes').select('id').eq('email', email).maybeSingle()
  if (!ib) {
    await send(chat, 'Usage: /disconnect name@company.com (see /inboxes)')
    return
  }
  // Best effort: revoke at Google too. Local data is removed either way.
  try {
    const { data: refresh } = await db.rpc('mailbot_read_refresh_token', { p_inbox_id: ib.id })
    if (refresh) {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refresh }),
      })
    }
  } catch (e) {
    console.error('revoke', e)
  }
  await db.rpc('mailbot_delete_inbox', { p_inbox_id: ib.id })
  await send(chat, '🗑 Disconnected ' + esc(email) + '.', TRASH)
}

async function cmdUnread(cfg: Config, chat: string): Promise<void> {
  const inboxes = await connectedInboxes()
  if (!inboxes.length) {
    await send(chat, 'No inboxes connected yet. Send /connect.')
    return
  }
  const muted = await loadMuted()
  let total = 0
  const lists = await Promise.all(inboxes.map(async (ib) => {
    try {
      const list = await gmail(ib, 'messages?' + new URLSearchParams({ q: 'in:inbox is:unread ' + SKIP_QUERY, maxResults: '10' }))
      total += list.resultSizeEstimate ?? 0
      // deno-lint-ignore no-explicit-any
      const msgs = await Promise.all((list.messages ?? []).map((m: any) =>
        gmail(ib, `messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`)
      ))
      return msgs.map((m) => ({ ib, email: readEmail(m) }))
        .filter((x) => !isMuted(muted, x.email.from.email, x.email.subject) && matchRules(x.email, ib.keywords).pass)
    } catch (e) {
      console.error('unread', ib.email, e)
      return []
    }
  }))
  const items = lists.flat().sort((a, b) => b.email.date.getTime() - a.email.date.getTime()).slice(0, 10)
  if (!items.length) {
    await send(chat, '📭 No unread emails.', TRASH)
    return
  }
  const tz = cfg.time_zone || DEFAULT_TIME_ZONE
  const lines = ['📬 <b>Unread</b> (about ' + total + '). Newest first, tap a number to open one here.', '']
  const buttons: Button[] = []
  items.forEach(({ ib, email }, i) => {
    lines.push((i + 1) + '. <a href="' + esc(gmailLink(ib.email, email.id)) + '">' +
      esc(clip(email.subject || '(no subject)', 80)) + '</a>')
    lines.push('     ' + esc(email.from.label) + ' → ' + esc(ib.label || ib.email) + ' · ' + fmtDate(email.date, tz))
    buttons.push({ text: String(i + 1), callback_data: `o:${ib.id}:${email.id}` })
  })
  const rows: Button[][] = []
  for (let i = 0; i < buttons.length; i += 5) rows.push(buttons.slice(i, i + 5))
  rows.push([{ text: '🗑', callback_data: 'X' }])
  await send(chat, lines.join('\n'), { inline_keyboard: rows })
}

async function cmdMute(chat: string, arg: string, on: boolean): Promise<void> {
  const entry = arg.toLowerCase().replace(/^@/, '')
  if (!/^([^\s@]+@)?[^\s@]+\.[^\s@]+$/.test(entry)) {
    await send(chat, 'Usage: /' + (on ? 'mute' : 'unmute') + ' name@company.com or company.com')
    return
  }
  if (on) await db.from('mailbot_muted').upsert({ entry })
  else await db.from('mailbot_muted').delete().eq('entry', entry)
  await send(chat, (on ? '🔕 Stopped: ' : '🔔 Back on: ') + esc(describeMute(entry)), TRASH)
}

/** /muted: everything stopped with 🔕, one tap to undo each. */
async function mutedList(): Promise<{ text: string; markup: { inline_keyboard: Button[][] } }> {
  const { data, error } = await db.from('mailbot_muted').select('id, entry').order('created_at', { ascending: false })
  if (error) throw new Error('mute list: ' + error.message)
  const all = data ?? []
  if (!all.length) return { text: 'Nothing is stopped. Use 🔕 on an email to stop emails like it.', markup: TRASH }
  // Telegram refuses keyboards with about 100 buttons, so the newest 50 get one each.
  const rows = all.slice(0, 50)
  return {
    text: '🔕 <b>Stopped</b>. Tap one to get those emails again.' +
      (all.length > rows.length ? '\nShowing the newest ' + rows.length + ' of ' + all.length + '. For older ones: /unmute name@company.com' : ''),
    markup: {
      inline_keyboard: [
        ...rows.map((r) => [{ text: '↩ ' + clip(describeMute(r.entry), 55), callback_data: 'q:' + r.id }]),
        [{ text: '🗑', callback_data: 'X' }],
      ],
    },
  }
}

async function cmdMuted(chat: string): Promise<void> {
  const list = await mutedList()
  await send(chat, list.text, list.markup)
}

async function cmdStatus(cfg: Config, chat: string): Promise<void> {
  const { data } = await db.from('mailbot_inboxes').select('status, last_error, last_checked_at')
  const rows = data ?? []
  const connected = rows.filter((r) => r.status === 'connected')
  const failing = connected.filter((r) => r.last_error).length
  const signedOut = rows.length - connected.length
  const last = connected.map((r) => Date.parse(r.last_checked_at ?? '') || 0).sort()[0]
  await send(chat, [
    cfg.paused === 'true' ? '⏸ Paused' : '✅ Running, checking every minute',
    'Inboxes: ' + connected.length + ' connected' + (failing ? ', ' + failing + ' failing' : '') +
      (signedOut ? ', ' + signedOut + ' signed out' : ''),
    'Oldest check: ' + (last ? Math.round((Date.now() - last) / 60_000) + ' min ago' : 'not yet'),
    'Stopped with 🔕: ' + (await loadMuted()).length,
  ].join('\n'), TRASH)
}

// -------------------------------------------------------------- callbacks --

// deno-lint-ignore no-explicit-any
async function onCallback(cfg: Config, q: any): Promise<void> {
  const chat = String(q.message.chat.id)
  const messageId: number = q.message.message_id
  const [act, a, b, c] = String(q.data ?? '').split(':')
  let toast = ''
  try {
    if (act === 'X') {
      await remove(chat, messageId)
    } else if (act === 'd') {
      // The card goes even when Gmail can't be reached (inbox disconnected, email gone).
      await remove(chat, messageId)
      toast = 'Removed from chat. Still in Gmail.'
      try {
        await gmail(await inboxById(Number(a)), `messages/${b}/modify`, { removeLabelIds: ['UNREAD'] })
        toast += ' Marked read.'
      } catch (e) {
        console.error('mark read on delete', e)
      }
    } else if (act === 'e' || act === 'z' || act === 'x') {
      toast = await onFilterButton(q, act === 'e' ? 'e' : 'z', a)
    } else if (act === 'q') {
      const { data: gone } = await db.from('mailbot_muted').delete().eq('id', Number(a)).select('entry').maybeSingle()
      if (gone) toast = 'Back on: ' + describeMute(gone.entry)
      const list = await mutedList()
      await edit(chat, messageId, list.text, list.markup)
    } else if (act === 'y' || act === 'Y') {
      toast = await sendPendingReply(q, a, act === 'Y')
    } else if (act === 'n') {
      await db.from('mailbot_pending_replies').delete().eq('key', a)
      await clearReplyMessages(q)
      toast = 'Cancelled'
    } else if (b) {
      toast = await onEmailButton(cfg, q, act, await inboxById(Number(a)), b, c)
    }
  } catch (e) {
    console.error('callback', q.data, e)
    toast = 'Failed: ' + errorText(e)
  }
  await tg('answerCallbackQuery', {
    callback_query_id: q.id,
    text: toast.slice(0, 190),
    show_alert: toast.startsWith('Failed'),
  })
}

/** Buttons on an email card. Old cards from before the redesign still send r, m and o. */
// deno-lint-ignore no-explicit-any
async function onEmailButton(cfg: Config, q: any, act: string, ib: Inbox, id: string, kind?: string): Promise<string> {
  const chat = String(q.message.chat.id)
  const messageId: number = q.message.message_id
  switch (act) {
    case 'v':
      await showCard(q, ib, id, 'more', cfg)
      return ''
    case 'c':
      await showCard(q, ib, id, 'min', cfg)
      return ''
    case 'f':
      await showCard(q, ib, id, 'full', cfg)
      return ''
    case 'p':
      await sendFiles(chat, ib, id, messageId)
      return ''
    case 'r':
      await gmail(ib, `messages/${id}/modify`, { removeLabelIds: ['UNREAD'] })
      return 'Marked as read'
    case 'a': {
      const m = await gmail(ib, `messages/${id}?format=minimal`)
      await gmail(ib, `threads/${m.threadId}/modify`, { removeLabelIds: ['INBOX', 'UNREAD'] })
      await remove(chat, messageId)
      return 'Archived in Gmail'
    }
    case 's': {
      const email = readEmail(await gmail(ib, `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`))
      await tg('editMessageReplyMarkup', { chat_id: chat, message_id: messageId, reply_markup: stopKeyboard(ib.id, email) })
      return ''
    }
    case 'M':
    case 'm': {
      const email = readEmail(await gmail(ib, `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`))
      const entry = muteEntry(email, kind ?? 's')
      if (!entry) return 'This email has no sender address to stop'
      await db.from('mailbot_muted').upsert({ entry })
      const undo = { text: '↩ Undo', callback_data: `U:${ib.id}:${id}:${kind ?? 's'}` }
      await edit(chat, messageId, '🔕 Stopped: ' + esc(describeMute(entry)),
        { inline_keyboard: [[undo, { text: '🗑', callback_data: 'X' }]] })
      return 'Stopped'
    }
    case 'U': {
      const email = await fetchEmail(ib, id)
      const entry = muteEntry(email, kind ?? 's')
      if (entry) await db.from('mailbot_muted').delete().eq('entry', entry)
      await edit(chat, messageId, cardFor(ib, email, cfg.time_zone || DEFAULT_TIME_ZONE, 'min'), cardButtons(ib, email, 'min'))
      return 'Back on'
    }
    case 'o':
      await postCard(ib, await fetchEmail(ib, id), chat, cfg.time_zone || DEFAULT_TIME_ZONE, 'more')
      return ''
  }
  return ''
}

// ---------------------------------------------------------------- filters --

function describeFilter(ib: Inbox): string {
  return ib.keywords?.length ? ib.keywords.join(', ') : 'all mail'
}

/** A rule as the user should read it: "payment (and similar: pay, paid, invoice…) + insurance (…)". */
function describeRule(rule: string): string {
  return rule.split(' + ').map((w) => {
    const similar = similarWords(w)
    return similar.length ? w + ' (and similar: ' + similar.slice(0, 5).join(', ') + '…)' : w
  }).join(' + ')
}

/** The inboxes a filter target names: one inbox id, or "all". */
async function filterTargets(target: string): Promise<Inbox[]> {
  const { data } = await db.from('mailbot_inboxes').select('*').order('id')
  const inboxes = (data ?? []) as Inbox[]
  return target === 'all' ? inboxes : inboxes.filter((ib) => String(ib.id) === target)
}

/** Replaces the target inboxes' rules with what the user typed; "all" / "off" removes the filter. */
async function applyFilter(chat: string, target: string, input: string): Promise<void> {
  const inboxes = await filterTargets(target)
  if (!inboxes.length) {
    await send(chat, 'That inbox is no longer connected. See /inboxes')
    return
  }
  const rules = /^\s*(off|all|none|все|выкл|нет)\s*$/i.test(input) ? [] : parseRules(input)
  await db.from('mailbot_inboxes').update({ keywords: rules }).in('id', inboxes.map((ib) => ib.id))
  const who = target === 'all' ? 'all inboxes' : inboxes[0].email
  if (!rules.length) {
    await send(chat, '✅ ' + esc(who) + ': you get all emails now.', TRASH)
    return
  }
  await send(chat, [
    '✅ <b>' + esc(who) + '</b>: you only get emails that have',
    ...rules.map((r) => '• ' + esc(describeRule(r))),
    '',
    'The rest isn\'t lost: you get a list of them every day. To see it now: /skipped',
  ].join('\n'), TRASH)
}

/** After "✏️" the next plain message is the word list; this applies it. */
async function applyAwaitedFilter(cfg: Config, chat: string, text: string): Promise<boolean> {
  const [target, at] = (cfg.awaiting_filter ?? '').split('|')
  if (!target) return false
  await db.from('mailbot_config').delete().eq('key', 'awaiting_filter')
  if (Date.now() - Number(at) > FILTER_WAIT_MS) return false
  await applyFilter(chat, target, text)
  return true
}

async function askFilterWords(chat: string, target: string): Promise<void> {
  const inboxes = await filterTargets(target)
  if (!inboxes.length) {
    await send(chat, 'That inbox is no longer connected. See /inboxes')
    return
  }
  await setConfig('awaiting_filter', target + '|' + Date.now())
  const who = target === 'all' ? 'all inboxes' : inboxes[0].email
  await send(chat, [
    '✏️ Type the words for <b>' + esc(who) + '</b> in one message.',
    ...(target === 'all' ? [] : ['Now: ' + esc(describeFilter(inboxes[0]))]),
    '',
    'An email comes through if it matches at least one rule.',
    'Commas, if any word is enough: <code>payment, erbol</code>',
    'Plus, if both words must be there: <code>payment + insurance</code>',
    'Similar words count too: payment also finds invoice and «оплата».',
    '',
    'The new list replaces the old one.',
  ].join('\n'), { inline_keyboard: [[{ text: '🌐 All emails (no filter)', callback_data: 'z:' + target }]] })
}

async function cmdFilter(chat: string, arg: string): Promise<void> {
  const inboxes = await filterTargets('all')
  if (!inboxes.length) {
    await send(chat, 'Connect an inbox first: /connect')
    return
  }
  if (arg) {
    const [first, ...rest] = arg.split(/\s+/)
    const target = /^(all|все)$/i.test(first)
      ? 'all'
      : String(inboxes.find((ib) => ib.email === first.toLowerCase())?.id ?? '')
    if (!target) {
      await send(chat, 'Usage: /filter name@gmail.com payment, erbol\nOr just /filter and pick an inbox.')
      return
    }
    const words = rest.join(' ').trim()
    return words ? await applyFilter(chat, target, words) : await askFilterWords(chat, target)
  }
  const lines = ['🏷 <b>Filters</b>', '', ...inboxes.map((ib) => esc(ib.email) + ': ' + esc(describeFilter(ib))), '',
    'Tap an inbox and type the words. Emails without them won\'t come to Telegram.']
  const rows: Button[][] = inboxes.map((ib) => [{ text: '✏️ ' + ib.email, callback_data: 'e:' + ib.id }])
  if (inboxes.length > 1) rows.push([{ text: '✏️ All inboxes at once', callback_data: 'e:all' }])
  await send(chat, lines.join('\n'), { inline_keyboard: rows })
}

// deno-lint-ignore no-explicit-any
async function onFilterButton(q: any, act: string, target: string): Promise<string> {
  const chat = String(q.message.chat.id)
  if (act === 'e') {
    await askFilterWords(chat, target)
    return ''
  }
  await db.from('mailbot_config').delete().eq('key', 'awaiting_filter')
  await applyFilter(chat, target, 'all')
  return 'Filter removed'
}

/**
 * Emails the filters held back, newest first. Sent once a day and on /skipped,
 * so a filter never makes an email disappear unseen.
 */
async function sendDigest(cfg: Config, chat: string, scheduled: boolean): Promise<void> {
  const { data } = await db.from('mailbot_skipped').select('inbox_id, message_id, sender, subject, received_at')
    .order('received_at', { ascending: false }).limit(500)
  const rows = data ?? []
  if (!rows.length) {
    if (!scheduled) await send(chat, '📭 Your filters held nothing back.', TRASH)
    return
  }
  const { data: inboxes } = await db.from('mailbot_inboxes').select('id, email')
  const emailOf = new Map((inboxes ?? []).map((ib) => [ib.id, ib.email]))
  const tz = cfg.time_zone || DEFAULT_TIME_ZONE
  const shown = rows.slice(0, DIGEST_ITEMS)
  const lines = [
    '📋 <b>Filters held back ' + rows.length + '</b>' + (rows.length > shown.length ? ' (latest ' + shown.length + ' here)' : ''),
    'Anything important? Add a word with /filter.',
    '',
  ]
  for (const r of shown) {
    const inbox = emailOf.get(r.inbox_id) ?? ''
    lines.push('• <a href="' + esc(gmailLink(inbox, r.message_id)) + '">' + esc(clip(r.subject || '(no subject)', 60)) + '</a>')
    lines.push('   ' + esc(clip(r.sender, 30)) + ' → ' + esc(inbox) + ' · ' + fmtDate(new Date(r.received_at), tz))
  }
  const res = await send(chat, lines.join('\n'), TRASH)
  if (res.ok) {
    for (const r of shown) {
      await db.from('mailbot_skipped').delete().eq('inbox_id', r.inbox_id).eq('message_id', r.message_id)
    }
  }
}

// ---------------------------------------------------------------- replies --

// deno-lint-ignore no-explicit-any
async function onReply(chat: string, m: any, text: string): Promise<void> {
  const ref = refFromEntities(m.reply_to_message.entities) ?? refFromEntities(m.reply_to_message.caption_entities)
  if (!ref) {
    await send(chat, 'Reply to one email\'s message to answer it.')
    return
  }
  if (!text) {
    await send(chat, 'Only text replies work for now.')
    return
  }
  const { data: ib } = await db.from('mailbot_inboxes').select('*').eq('email', ref.inbox).maybeSingle()
  if (!ib) {
    await send(chat, esc(ref.inbox) + ' isn\'t connected anymore. /connect it first.')
    return
  }
  const email = readEmail(await gmail(ib as Inbox, `messages/${ref.id}?format=metadata&${REPLY_HEADERS}`))
  const one = buildReply(email, ib.email, text, false)
  const all = buildReply(email, ib.email, text, true)
  const key = randomToken(9)
  await db.from('mailbot_pending_replies').insert({ key, inbox_id: ib.id, message_id: ref.id, body: text })
  await db.from('mailbot_pending_replies').delete().lt('created_at', new Date(Date.now() - 86_400_000).toISOString())

  const lines = ['↩️ <b>To:</b> ' + esc(one.to.join(', ')), '<b>From:</b> ' + esc(ib.email)]
  if (all.cc.length) lines.push('<b>Reply all also goes to:</b> ' + esc(all.cc.join(', ')))
  lines.push('', esc(text))
  const buttons: Button[] = [{ text: '✅ Send', callback_data: 'y:' + key }]
  if (all.cc.length) buttons.push({ text: '👥 Reply all', callback_data: 'Y:' + key })
  buttons.push({ text: '✖ Cancel', callback_data: 'n:' + key })
  await send(chat, lines.join('\n'), { inline_keyboard: [buttons] }, m.message_id)
}

/** After Send or Cancel, the typed reply and the confirmation leave the chat. */
// deno-lint-ignore no-explicit-any
async function clearReplyMessages(q: any): Promise<void> {
  const typed = q.message.reply_to_message?.message_id
  await remove(q.message.chat.id, q.message.message_id)
  if (typed) await tg('deleteMessage', { chat_id: q.message.chat.id, message_id: typed })
}

// deno-lint-ignore no-explicit-any
async function sendPendingReply(q: any, key: string, all: boolean): Promise<string> {
  // Deleting is the claim: a double tap or a Telegram retry finds nothing the second time.
  const { data: p } = await db.from('mailbot_pending_replies').delete().eq('key', key).select().maybeSingle()
  if (!p) return 'Already sent or cancelled'
  let reply
  try {
    const ib = await inboxById(p.inbox_id)
    const email = readEmail(await gmail(ib, `messages/${p.message_id}?format=metadata&${REPLY_HEADERS}`))
    reply = buildReply(email, ib.email, p.body, all)
    await gmail(ib, 'messages/send', { raw: reply.raw, threadId: email.threadId })
  } catch (e) {
    // Not sent: put the reply back so Send can be tapped again.
    await db.from('mailbot_pending_replies').insert(p)
    throw e
  }
  await clearReplyMessages(q)
  return 'Sent to ' + [...reply.to, ...reply.cc].join(', ')
}

// ----------------------------------------------------------------- routes --

async function handleTelegram(req: Request): Promise<Response> {
  const cfg = await loadConfig()
  if (!cfg.webhook_secret || req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== cfg.webhook_secret) {
    return new Response('forbidden', { status: 403 })
  }
  const update = await req.json().catch(() => null)
  // Answer Telegram right away; a slow reply would make it resend the update.
  if (update) background(onUpdate(cfg, update).catch((e) => console.error('update', e)))
  return new Response('ok')
}

async function handleConnect(req: Request): Promise<Response> {
  const state = new URL(req.url).searchParams.get('s') ?? ''
  const { data: hs } = await db.from('mailbot_oauth_states').select('code_verifier, login_hint, expires_at')
    .eq('state', state).maybeSingle()
  if (!hs || Date.parse(hs.expires_at) < Date.now()) {
    return page('This sign-in link has expired or was already used. Send /connect in Telegram for a new one.', 400)
  }
  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES)
  // offline + consent together make Google return a refresh token every time.
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'select_account consent')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', await pkceChallenge(hs.code_verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  if (hs.login_hint) url.searchParams.set('login_hint', hs.login_hint)
  return Response.redirect(url.toString(), 302)
}

async function handleCallback(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams
  if (params.get('error')) {
    return page('Google said: ' + params.get('error') + '. Send /connect in Telegram to try again.', 400)
  }
  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) return page('Missing sign-in details. Send /connect in Telegram to try again.', 400)

  // Single use: deleted on read, so a replayed callback can't connect anything.
  const { data: hs } = await db.from('mailbot_oauth_states').delete().eq('state', state)
    .select('code_verifier, expires_at').maybeSingle()
  if (!hs || Date.parse(hs.expires_at) < Date.now()) {
    return page('This sign-in link has expired or was already used. Send /connect in Telegram for a new one.', 400)
  }

  const t = await postToken({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    code,
    code_verifier: hs.code_verifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  })
  if (!t.access_token) return page('Google refused the sign-in: ' + (t.error_description ?? t.error) + '.', 400)
  if (!String(t.scope ?? '').includes(GMAIL_SCOPE)) {
    return page('Gmail access wasn\'t granted. Send /connect again and tick the Gmail box on Google\'s permission screen.', 400)
  }
  if (!t.refresh_token) {
    return page('Google didn\'t hand out a lasting token. Send /connect again.', 400)
  }

  const profileRes = await fetch(GMAIL + 'profile', { headers: { Authorization: 'Bearer ' + t.access_token } })
  if (!profileRes.ok) {
    return page('Signed in, but Gmail refused access (' + profileRes.status + '). Is the Gmail API enabled in Google Cloud?', 502)
  }
  const profile = await profileRes.json()
  const email = String(profile.emailAddress ?? idTokenEmail(t.id_token)).toLowerCase()

  const { data: row, error } = await db.from('mailbot_inboxes').upsert({
    email,
    status: 'connected',
    last_error: null,
    access_token: t.access_token,
    access_token_expires_at: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString(),
    history_id: String(profile.historyId),
    connected_at: new Date().toISOString(),
  }, { onConflict: 'email' }).select('id').single()
  if (error || !row) return page('Couldn\'t save the inbox: ' + (error?.message ?? 'unknown') + '.', 500)
  const { error: vaultError } = await db.rpc('mailbot_store_refresh_token', { p_inbox_id: row.id, p_token: t.refresh_token })
  if (vaultError) return page('Couldn\'t store the token: ' + vaultError.message + '.', 500)

  const cfg = await loadConfig()
  if (cfg.owner_chat_id) {
    await send(cfg.owner_chat_id, '✅ <b>' + esc(email) + '</b> is connected. New mail from it will show up here.\n\n' +
      '/connect adds another inbox.', TRASH)
  }
  if (cfg.bot_username) return Response.redirect('https://t.me/' + cfg.bot_username, 302)
  return page('✅ ' + email + ' is connected. You can go back to Telegram.')
}

async function handleCron(req: Request): Promise<Response> {
  const cfg = await loadConfig()
  if (!cfg.cron_token || req.headers.get('Authorization') !== 'Bearer ' + cfg.cron_token) {
    return json({ error: 'unauthorized' }, 401)
  }
  if (!cfg.owner_chat_id || cfg.paused === 'true') return json({ skipped: true })
  const job = ((await req.json().catch(() => ({}))) as { job?: string }).job
  if (job === 'digest') background(sendDigest(cfg, cfg.owner_chat_id, true).catch((e) => console.error('digest', e)))
  else background(pollAll(cfg).catch((e) => console.error('cron', e)))
  return json({ ok: true })
}

/** Public and deliberately boring: counts and ages only, no addresses. */
async function handleHealth(): Promise<Response> {
  const cfg = await loadConfig()
  const { data } = await db.from('mailbot_inboxes').select('status, last_error, last_checked_at')
  const rows = data ?? []
  const connected = rows.filter((r) => r.status === 'connected')
  const oldest = connected.map((r) => Date.parse(r.last_checked_at ?? '') || 0).sort()[0]
  const minutes = oldest ? Math.round((Date.now() - oldest) / 60_000) : null
  const paused = cfg.paused === 'true'
  const ok = Boolean(cfg.owner_chat_id) && (paused || !connected.length || (minutes !== null && minutes <= 5))
  return json({
    ok,
    paired: Boolean(cfg.owner_chat_id),
    paused,
    google_configured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    inboxes: connected.length,
    signed_out: rows.length - connected.length,
    failing: connected.filter((r) => r.last_error).length,
    oldest_check_minutes_ago: minutes,
  }, ok ? 200 : 503)
}

Deno.serve(async (req) => {
  const route = new URL(req.url).pathname.split('/').filter(Boolean).pop()
  try {
    switch (route) {
      case 'telegram':
        return req.method === 'POST' ? await handleTelegram(req) : json({ error: 'not_found' }, 404)
      case 'connect':
        return await handleConnect(req)
      case 'callback':
        return await handleCallback(req)
      case 'cron':
        return await handleCron(req)
      case 'health':
        return await handleHealth()
      default:
        return json({ error: 'not_found' }, 404)
    }
  } catch (e) {
    console.error('mail-bot', route, e)
    return json({ error: 'internal' }, 500)
  }
})
