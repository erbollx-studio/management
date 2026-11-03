import 'jsr:@supabase/functions-js@2/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  addWorkingHours,
  answeredAfter,
  base64urlToBytes,
  buildReply,
  calendarLink,
  cardText,
  clip,
  dayKey,
  deadlineTimes,
  decide,
  decodeEntities,
  describeMute,
  dueLine,
  type Email,
  emailKeyboard,
  esc,
  findDeadline,
  fmtDate,
  fmtWhen,
  gmailLink,
  inboxName,
  INSURANCE_WORDS,
  isMuted,
  isNoReply,
  isQuiet,
  laterKeyboard,
  laterTime,
  MONEY_WORDS,
  muteEntry,
  parseQuiet,
  parseRules,
  type Person,
  personFor,
  preview,
  readableBody,
  readEmail,
  refFromEntities,
  senderEntry,
  shouldSkip,
  similarWords,
  stopKeyboard,
  taggedIds,
  URGENT_WORDS,
  type Attachment,
  type Button,
  type Day,
  type HistoryRecord,
} from './mail.ts'

/**
 * Mail bot: posts new mail from every connected inbox to one Telegram chat and
 * acts on it from there. Each email is sorted into a template (🔴 urgent
 * insurance, 💰 insurance payment, 🧾 invoice / payment, ⭐ your people) and
 * arrives as a short card: the template, From and To, the subject, the first
 * lines. Load emails never come, and money emails only from senders on the
 * money list (/senders; a new sender is asked about once). Emails that fit no
 * template go to the daily list instead, unless the inbox is set to all
 * emails. An email you put the Gmail label "erbol" on (the tag) always comes,
 * whatever the filters. ▾ More shows the rest, ↩ Reply answers it, 🗑 removes
 * it from the chat, 🔕 stops emails like it. Each inbox connects with Google
 * sign-in; nothing is forwarded anywhere.
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
const CARD_CHARS = 200
const PREVIEW_CHARS = 1200
const FULL_CHARS = 3300
const MAX_EMAILS_PER_RUN = 15
/** A check stops taking new emails after this; the rest comes next minute. */
const RUN_MS = 40_000
/** One check at a time. A check that was cut off frees the lock after this. */
const LOCK_MS = 3 * 60_000
const TG_TIMEOUT_MS = 20_000
const TG_FILE_TIMEOUT_MS = 120_000
const GMAIL_TIMEOUT_MS = 30_000
const MAX_ATTACHMENTS = 10
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const EXPIRY_MARGIN_MS = 60_000
const DEFAULT_TIME_ZONE = 'Asia/Bishkek'
const FILTER_WAIT_MS = 10 * 60_000
const DIGEST_ITEMS = 20
const DEFAULT_TAG = 'erbol'
const TAG_RECHECK_MS = 60 * 60_000
const DEFAULT_QUIET = '22-7'

/** A 🗑 button for messages that are not email cards (files, lists, confirmations). */
const TRASH = { inline_keyboard: [[{ text: '🗑', callback_data: 'X' }]] }

const HELP = [
  '<b>Commands</b>',
  '/connect: add an inbox (sign in with Google)',
  '/inboxes: connected inboxes',
  '/disconnect name@company.com: remove an inbox',
  '/unread: latest unread emails',
  '/templates: what 🔴 💰 🧾 ⭐ look for',
  '/people: your ⭐ people, their emails always come through',
  '/senders: who may send you money emails (✓ Allow on a new sender adds them)',
  '📌 Put the Gmail label "erbol" on any email and it comes here, whatever the filters.',
  '/filter: per inbox: templates only, extra words, or all emails',
  '/skipped: emails that fit no template (the daily list)',
  '/muted: what you stopped with 🔕, tap to undo',
  '/check: check all inboxes now',
  '/quiet: night hours without sound (only 🔴 rings)',
  '/pause, /resume: stop or restart notifications',
  '/status: is everything working',
  '📅 An email with a due date comes back 3 days before and on the day, at 9:00.',
  '⏳ A ⭐ or 📌 email nobody answered in 4 working hours comes back once.',
  '',
  'On an email: ▾ More shows the rest, ↩ Reply answers it, ⏰ brings it back later, 🗑 removes it from this chat ' +
  '(it stays in Gmail), 🔕 stops emails like it.',
  'Replies: tap ↩ Reply (or swipe the email) and type your answer. I show you the reply before it goes out.',
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
  /** templates: only template emails and the inbox's own words come through. all: every email does. */
  mode: 'templates' | 'all'
  /** The Gmail label id of the tag ("erbol") in this inbox, and when it was last looked up. */
  tag_label_id: string | null
  tag_checked_at: string | null
}

/** A row of mailbot_reminders: something to send at `due_at`. */
interface Reminder {
  id: number
  kind: 'later' | 'deadline' | 'unanswered'
  inbox_id: number
  message_id: string
  thread_id: string
  due_at: string
  note: string
  tries: number
}

/** What sorting emails and drawing cards needs besides the email itself. */
interface Ctx {
  tz: string
  muted: string[]
  people: Person[]
  /** The money list: sender entry → allowed, asked or denied. */
  senders: Record<string, string>
  /** The Gmail label name that sends an email here whatever the filters. */
  tag: string
  /** Night hours when cards arrive without sound (🔴 still rings), or null for never. */
  quiet: { from: number; to: number } | null
  /** During a mail check: the time (ms) after which it takes no new emails. */
  until?: number
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

async function loadCtx(cfg: Config): Promise<Ctx> {
  const [muted, { data: people }, { data: senders }] = await Promise.all([
    loadMuted(),
    db.from('mailbot_people').select('entry, name, note'),
    db.from('mailbot_senders').select('entry, status'),
  ])
  return {
    tz: cfg.time_zone || DEFAULT_TIME_ZONE,
    muted,
    people: (people ?? []) as Person[],
    senders: Object.fromEntries((senders ?? []).map((s) => [s.entry, s.status])),
    tag: cfg.tag_label || DEFAULT_TAG,
    quiet: parseQuiet(cfg.quiet_hours ?? DEFAULT_QUIET),
  }
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
  const isFile = payload instanceof FormData
  const init: RequestInit = isFile
    ? { method: 'POST', body: payload }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  for (let attempt = 0; ; attempt++) {
    let body: TgResult
    try {
      // Telegram once hung for two minutes; a call that never ends would hold up the whole check.
      const signal = AbortSignal.timeout(isFile ? TG_FILE_TIMEOUT_MS : TG_TIMEOUT_MS)
      const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, { ...init, signal })
      body = await res.json()
    } catch (e) {
      // A timeout isn't tried again here: Telegram may have taken the message anyway.
      const timedOut = e instanceof DOMException && e.name === 'TimeoutError'
      if (attempt < 2 && !timedOut) {
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

/** `silent`: the message arrives without sound or vibration. */
async function send(chat: string, text: string, markup?: unknown, replyTo?: number, silent = false): Promise<TgResult> {
  const payload: Record<string, unknown> = {
    chat_id: chat,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  }
  if (markup) payload.reply_markup = markup
  if (replyTo) payload.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true }
  if (silent) payload.disable_notification = true
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
    signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
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
    signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
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
  const ctx = await loadCtx(cfg)
  ctx.until = Date.now() + RUN_MS
  const counts = await Promise.all((await connectedInboxes()).map(async (ib) => {
    try {
      return await pollInbox(ib, chat, ctx)
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

/** Every Gmail history record of `types` since the inbox's cursor for messages with `labelId`, all pages. */
async function historySince(ib: Inbox, chat: string, labelId: string, types: string[]) {
  const records: HistoryRecord[] = []
  let latest = ib.history_id!
  let pageToken = ''
  do {
    const q = new URLSearchParams({ startHistoryId: ib.history_id!, labelId })
    for (const t of types) q.append('historyTypes', t)
    if (pageToken) q.set('pageToken', pageToken)
    const body = await gmail(ib, 'history?' + q, undefined, chat)
    records.push(...(body.history ?? []))
    if (body.historyId) latest = String(body.historyId)
    pageToken = body.nextPageToken ?? ''
  } while (pageToken)
  return { records, latest }
}

/**
 * Posts what arrived since the inbox's history cursor, and every email that
 * got the tag label since then. Gmail's history API lists only changes, so a
 * quiet inbox costs two small calls a minute.
 */
async function pollInbox(ib: Inbox, chat: string, ctx: Ctx): Promise<number> {
  const now = new Date().toISOString()
  if (ib.label === null) await rememberInboxName(ib)
  if (!ib.history_id) {
    const profile = await gmail(ib, 'profile', undefined, chat)
    await db.from('mailbot_inboxes').update({ history_id: String(profile.historyId), last_checked_at: now, last_error: null })
      .eq('id', ib.id)
    return 0
  }

  const tagId = await tagLabelId(ib, ctx.tag)
  let arrived, tagging
  try {
    arrived = await historySince(ib, chat, 'INBOX', ['messageAdded'])
    tagging = tagId ? await historySince(ib, chat, tagId, ['messageAdded', 'labelAdded']) : arrived
  } catch (e) {
    // 404: the cursor aged out (Gmail keeps about a week). Start again from now.
    if (e instanceof GmailError && e.status === 404) {
      ib.history_id = null
      return await pollInbox(ib, chat, ctx)
    }
    throw e
  }
  const tagged = tagId ? taggedIds(tagging.records, tagId) : []
  const ids: string[] = []
  for (const h of arrived.records) {
    for (const added of h.messagesAdded ?? []) {
      const m = added.message
      if (!shouldSkip(m.labelIds ?? [], SKIP_CATEGORIES) && !ids.includes(m.id) && !tagged.includes(m.id)) ids.push(m.id)
    }
  }
  const latest = BigInt(arrived.latest) > BigInt(tagging.latest) ? arrived.latest : tagging.latest

  // Tagged emails first. Their key is "tag:<id>", so an email already posted
  // (or held back) when it arrived still comes once more when it gets the tag.
  const jobs = [...tagged.map((id) => ({ id, tagged: true })), ...ids.map((id) => ({ id, tagged: false }))]
    .map((j) => ({ ...j, key: (j.tagged ? 'tag:' : '') + j.id }))
  const done = await seenKeys(ib.id, jobs.map((j) => j.key))
  let posted = 0
  let handled = 0
  let finished = true
  for (const job of jobs) {
    if (done.has(job.key)) continue
    if (handled === MAX_EMAILS_PER_RUN || Date.now() > (ctx.until ?? Infinity)) {
      finished = false
      break
    }
    handled++
    try {
      if (await deliver(ib, job.id, chat, ctx, job.tagged)) posted++
    } catch (e) {
      const gone = e instanceof GmailError && e.status === 404 // deleted before we got to it
      if (!gone) console.error('deliver', ib.email, job.id, e)
      if (!gone && !(e instanceof TelegramError && !e.transient)) {
        // Worth another try: it stays unmarked and the cursor stays, so it comes again next minute.
        finished = false
        continue
      }
    }
    // Marked only once it's handled. Marking first lost an email: a check stuck
    // on Telegram held the mark, the next check stepped past it, then the stuck one failed.
    await db.from('mailbot_seen')
      .upsert({ inbox_id: ib.id, message_id: job.key }, { onConflict: 'inbox_id,message_id', ignoreDuplicates: true })
  }

  // A cut-short or failed run keeps the cursor, so the rest comes next minute;
  // mailbot_seen skips whatever was already handled.
  const update: Record<string, unknown> = { last_checked_at: now, last_error: null }
  if (finished) update.history_id = latest
  await db.from('mailbot_inboxes').update(update).eq('id', ib.id)
  return posted
}

/** Which of these keys mailbot_seen already has. A failed read stops the check rather than post everything again. */
async function seenKeys(inboxId: number, keys: string[]): Promise<Set<string>> {
  const done = new Set<string>()
  for (let i = 0; i < keys.length; i += 100) {
    const { data, error } = await db.from('mailbot_seen').select('message_id')
      .eq('inbox_id', inboxId).in('message_id', keys.slice(i, i + 100))
    if (error) throw new Error('mailbot_seen: ' + error.message)
    for (const r of data ?? []) done.add(r.message_id)
  }
  return done
}

/**
 * The id of the tag label ("erbol") in this inbox. The first time, the bot
 * makes the label if the inbox doesn't have it, so it is in Gmail's label menu
 * right away; after that it only looks it up, once an hour, so a deleted or
 * renamed label isn't made again.
 */
async function tagLabelId(ib: Inbox, name: string): Promise<string | null> {
  const fresh = Date.parse(ib.tag_checked_at ?? '') > Date.now() - TAG_RECHECK_MS
  if (fresh) return ib.tag_label_id
  let id: string | null = null
  try {
    const { labels } = await gmail(ib, 'labels')
    // deno-lint-ignore no-explicit-any
    id = (labels ?? []).find((l: any) => String(l.name).toLowerCase() === name.toLowerCase())?.id ?? null
    if (!id && !ib.tag_checked_at) {
      id = (await gmail(ib, 'labels', { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' })).id ?? null
    }
  } catch (e) {
    console.error('tag label', ib.email, e)
    return ib.tag_label_id
  }
  ib.tag_label_id = id
  ib.tag_checked_at = new Date().toISOString()
  await db.from('mailbot_inboxes').update({ tag_label_id: id, tag_checked_at: ib.tag_checked_at }).eq('id', ib.id)
  return id
}

/** The inbox's name for the To line, asked from Gmail once; '' when Gmail has none. */
async function rememberInboxName(ib: Inbox): Promise<void> {
  let name = ''
  try {
    const { sendAs } = await gmail(ib, 'settings/sendAs')
    // deno-lint-ignore no-explicit-any
    const self = (sendAs ?? []).find((s: any) => s.isPrimary || String(s.sendAsEmail).toLowerCase() === ib.email)
    name = String(self?.displayName ?? '').trim()
  } catch (e) {
    console.error('inbox name', ib.email, e)
  }
  ib.label = name
  await db.from('mailbot_inboxes').update({ label: name }).eq('id', ib.id)
}

async function deliver(ib: Inbox, id: string, chat: string, ctx: Ctx, tagged = false): Promise<boolean> {
  const email = readEmail(await gmail(ib, `messages/${id}?format=full`, undefined, chat))
  if (tagged) {
    // The tag is a request: it beats templates, filters and 🔕. Only spam and the bin stay out.
    if (email.labelIds.some((l) => l === 'SPAM' || l === 'TRASH')) return false
    await afterPost(ib, email, ctx, true, await postCard(ib, email, chat, ctx, 'min'))
    return true
  }
  if (shouldSkip(email.labelIds, SKIP_CATEGORIES)) return false
  if (email.from.email === ib.email) return false // mail you sent to yourself
  if (isMuted(ctx.muted, email.from.email, email.subject)) return false
  const d = decide(email, ctx.people, ib.keywords, ctx.senders)
  if (ib.mode !== 'all' && d.send === 'list') {
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
  const due = await postCard(ib, email, chat, ctx, 'min')
  if (d.send === 'ask') {
    // Asked once: until the answer, this sender's next money emails go to the daily list.
    // Only after the card arrived, so a failed send asks again on the retry.
    ctx.senders[d.sender] = 'asked'
    await db.from('mailbot_senders').upsert({ entry: d.sender, status: 'asked' }, {
      onConflict: 'entry',
      ignoreDuplicates: true,
    })
  }
  await afterPost(ib, email, ctx, false, due)
  return true
}

/**
 * After a new email reached the chat: its 📅 deadline reminders and its
 * "nobody answered" check. A failure here is logged and never fails the
 * delivery, so the email is still marked as handled.
 */
async function afterPost(ib: Inbox, email: Email, ctx: Ctx, tagged: boolean, due: Day | null): Promise<void> {
  try {
    if (due) await scheduleDeadline(ib, email, due, ctx.tz)
  } catch (e) {
    console.error('deadline', ib.email, email.id, e)
  }
  try {
    await scheduleUnanswered(ib, email, ctx, tagged)
  } catch (e) {
    console.error('unanswered', ib.email, email.id, e)
  }
}

// ------------------------------------------------------------------ cards --

interface Card {
  text: string
  markup: { inline_keyboard: Button[][] }
  /** 🔴 urgent insurance: rings even in the quiet hours. */
  urgent: boolean
}

/**
 * A card's text and buttons. A money email from a sender with no answer yet
 * carries ✓ Allow / ✕ Not money. `prefix` leads the top line ("⏰ Reminder").
 * `due` adds the 📅 line and its buttons; `done` (a 📅 reminder) offers ✓ Done
 * there instead of ✕ Wrong date.
 */
function renderCard(
  ib: Inbox,
  email: Email,
  ctx: Ctx,
  view: View,
  prefix = '',
  due: Day | null = null,
  done = false,
): Card {
  const d = decide(email, ctx.people, ib.keywords, ctx.senders)
  const isTagged = Boolean(ib.tag_label_id) && email.labelIds.includes(ib.tag_label_id!)
  const label = [prefix, isTagged ? '📌 ' + ctx.tag : '', d.label, d.asking ? '🆕 new sender' : '']
    .filter(Boolean).join(' · ')
  const link = gmailLink(ib.email, email.id)
  // In `base`, so all three views show the 📅 line.
  const base = {
    label,
    email,
    inbox: { email: ib.email, name: inboxName(ib.label, ib.email, email) },
    link,
    timeZone: ctx.tz,
    due: due ? dueLine(due, new Date(), ctx.tz) : undefined,
  }
  let text
  if (view === 'min') text = cardText({ ...base, body: preview(email, CARD_CHARS) })
  else if (view === 'more') {
    text = cardText({ ...base, details: true, tags: d.tags, body: clip(readableBody(email, true), PREVIEW_CHARS) })
  } else {
    const full = readableBody(email, false)
    const body = full.length > FULL_CHARS ? clip(full, FULL_CHARS) + '\n\n(the rest is in Gmail: ↗ Gmail)' : full
    text = cardText({ ...base, details: true, tags: d.tags, body })
  }
  const files = Math.min(email.attachments.length, MAX_ATTACHMENTS)
  const deadline = due ? { url: calendarLink(due, clip(email.subject || '(no subject)', 100), link), done } : undefined
  return {
    text,
    markup: emailKeyboard(ib.id, email.id, link, view, files, d.asking ? d.sender : '', deadline),
    urgent: d.kind === 'urgent',
  }
}

/**
 * Posts a card; in the quiet hours it arrives without sound, unless it's 🔴
 * urgent. `opts.quiet`: without sound anyway. `opts.done`: a 📅 reminder card,
 * so it offers ✓ Done instead of ✕ Wrong date. Returns the email's due date, or null.
 */
async function postCard(
  ib: Inbox,
  email: Email,
  chat: string,
  ctx: Ctx,
  view: View,
  prefix = '',
  opts: { quiet?: boolean; done?: boolean } = {},
): Promise<Day | null> {
  // A deadline problem never stops the card: it just comes without the 📅 line.
  let due: Day | null = null
  try {
    due = await deadlineOf(ib, email, ctx)
  } catch (e) {
    console.error('deadline', ib.email, email.id, e)
  }
  const card = renderCard(ib, email, ctx, view, prefix, due, opts.done ?? false)
  const silent = opts.quiet || (!card.urgent && isQuiet(new Date(), ctx.tz, ctx.quiet))
  const res = await send(chat, card.text, card.markup, undefined, silent)
  if (!res.ok) throw new TelegramError(res)
  return due
}

// deno-lint-ignore no-explicit-any
async function showCard(q: any, ib: Inbox, id: string, view: View, cfg: Config): Promise<void> {
  const [email, ctx] = await Promise.all([fetchEmail(ib, id), loadCtx(cfg)])
  const card = renderCard(ib, email, ctx, view, '', await deadlineOf(ib, email, ctx))
  await edit(q.message.chat.id, q.message.message_id, card.text, card.markup)
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
    case '/templates':
      return await cmdTemplates(chat)
    case '/people':
      return await cmdPeople(chat, arg)
    case '/senders': {
      const list = await sendersList()
      await send(chat, list.text, list.markup)
      return
    }
    case '/skipped':
      return await sendDigest(cfg, chat, false)
    case '/check': {
      if (cfg.paused === 'true') {
        await send(chat, '⏸ Paused. /resume first.')
        return
      }
      const lock = await takeLock()
      if (!lock) {
        await send(chat, '⏳ A check is running right now. New emails come within a minute.', TRASH)
        return
      }
      try {
        if (!(await pollAll(cfg))) await send(chat, '📭 Nothing new.', TRASH)
      } finally {
        await dropLock(lock)
      }
      return
    }
    case '/mute':
      return await cmdMute(chat, arg, true)
    case '/unmute':
      return await cmdMute(chat, arg, false)
    case '/muted':
      return await cmdMuted(chat)
    case '/quiet':
      return await cmdQuiet(cfg, chat, arg)
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
  const { data } = await db.from('mailbot_inboxes').select('email, status, last_error, keywords, mode').order('id')
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
  const ctx = await loadCtx(cfg)
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
        .filter((x) => !isMuted(ctx.muted, x.email.from.email, x.email.subject) &&
          (ib.mode === 'all' || decide(x.email, ctx.people, ib.keywords, ctx.senders).send !== 'list'))
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
  const tz = ctx.tz
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

/** /people name@company.com Anna Lee, insurance agent: adds or updates one; /people alone lists them. */
async function cmdPeople(chat: string, arg: string): Promise<void> {
  let added = ''
  if (arg) {
    const [first, ...rest] = arg.split(/\s+/)
    const entry = first.toLowerCase().replace(/^@/, '')
    if (!/^([^\s@]+@)?[^\s@]+\.[^\s@]+$/.test(entry)) {
      await send(chat, 'Usage: /people name@company.com Name, what they do\nOr a whole company: /people company.com Name')
      return
    }
    const [name, ...note] = rest.join(' ').split(/\s*(?:,|·|\s-\s)\s*/)
    const person = { entry, name: (name ?? '').trim(), note: note.join(', ').trim() }
    const { error } = await db.from('mailbot_people').upsert(person, { onConflict: 'entry' })
    if (error) throw new Error('people: ' + error.message)
    added = '✅ Added ' + esc(person.name || entry) + '.\n\n'
  }
  const list = await peopleList()
  await send(chat, added + list.text, list.markup)
}

async function peopleList(): Promise<{ text: string; markup: { inline_keyboard: Button[][] } }> {
  const { data, error } = await db.from('mailbot_people').select('id, entry, name, note').order('created_at')
  if (error) throw new Error('people: ' + error.message)
  const all = data ?? []
  const add = 'Add someone: <code>/people name@company.com Anna Lee, insurance agent</code>\n' +
    'Everyone at a company: <code>/people company.com Truck Insure</code>'
  if (!all.length) return { text: '⭐ <b>Your people</b>: nobody yet.\n\n' + add, markup: TRASH }
  const rows = all.slice(0, 50)
  return {
    text: [
      '⭐ <b>Your people</b>. Their emails always come through.',
      '',
      ...rows.map((p) => '• ' + esc([p.name, p.note].filter(Boolean).join(' · ') || p.entry) + (p.name ? ': ' + esc(p.entry) : '')),
      '',
      add,
      'Tap a name to remove it.',
    ].join('\n'),
    markup: {
      inline_keyboard: [
        ...rows.map((p) => [{ text: '✖ ' + clip(p.name || p.entry, 50), callback_data: 'P:' + p.id }]),
        [{ text: '🗑', callback_data: 'X' }],
      ],
    },
  }
}

/** /senders: the money list. Tapping one forgets it, so their next money email asks again. */
async function sendersList(): Promise<{ text: string; markup: { inline_keyboard: Button[][] } }> {
  const { data, error } = await db.from('mailbot_senders').select('id, entry, status').order('created_at')
  if (error) throw new Error('senders: ' + error.message)
  const all = data ?? []
  const group = (status: string, title: string) => {
    const entries = all.filter((s) => s.status === status).map((s) => esc(s.entry))
    return entries.length ? [title + ' ' + entries.join(', ')] : []
  }
  const text = [
    '💵 <b>Money emails</b> (🧾 💰) come only from these senders:',
    '',
    ...group('allowed', '✅'),
    ...group('asked', '⏳ Asked, no answer yet:'),
    ...group('denied', '✕ Not money:'),
    ...(all.length ? [] : ['Nobody yet.']),
    '',
    'A new sender comes once, with ✓ Allow. Tap a name below to forget it.',
  ].join('\n')
  const rows = all.slice(0, 50).map((s) => [{ text: '✖ ' + clip(s.entry, 50), callback_data: 'L:' + s.id }])
  return { text, markup: { inline_keyboard: [...rows, [{ text: '🗑', callback_data: 'X' }]] } }
}

/** /templates: what each template looks for, straight from the word lists. */
async function cmdTemplates(chat: string): Promise<void> {
  const words = (list: string[]) => esc(list.map((w) => w.replace(/\*$/, '')).join(', '))
  await send(chat, [
    '<b>Templates</b>. Every email is checked in this order:',
    '',
    '🔴 <b>Insurance · URGENT</b>: an insurance word and an urgent word',
    '💰 <b>Insurance payment</b>: a money word and an insurance word',
    '🧾 <b>Invoice / payment</b>: a money word',
    '⭐ <b>Your people</b>: anyone on /people, whatever the words',
    '',
    '<b>Money words:</b> ' + words(MONEY_WORDS),
    '<b>Insurance words:</b> ' + words(INSURANCE_WORDS),
    '<b>Urgent words:</b> ' + words(URGENT_WORDS),
    '',
    'Words count in the subject, the sender, file names and the first lines of the newest message. ' +
    'Signatures, footers and old replies don\'t count. Emails that fit no template go to the daily list (/skipped).',
    '',
    '🚚 Load emails never come, even with money words: load #, PO, rate confirmation, delivery receipt, BOL, POD, ' +
    'tender, pickup, lanes like "NV to Rocklin, CA".',
    '💵 🧾 and 💰 come only from senders you allowed (/senders). 🔴, ⭐ and 📌 always come.',
  ].join('\n'), TRASH)
}

/** /quiet shows the night hours, /quiet 23-6 changes them, /quiet off turns them off. */
async function cmdQuiet(cfg: Config, chat: string, arg: string): Promise<void> {
  let value = cfg.quiet_hours ?? DEFAULT_QUIET
  if (arg) {
    if (!/^\s*off\s*$/i.test(arg) && !parseQuiet(arg)) {
      await send(chat, 'Usage: /quiet 22-7 (from 22:00 to 7:00), or /quiet off', TRASH)
      return
    }
    value = /off/i.test(arg) ? 'off' : arg.trim()
    await setConfig('quiet_hours', value)
  }
  const quiet = parseQuiet(value)
  const hh = (h: number) => String(h).padStart(2, '0') + ':00'
  await send(chat, quiet
    ? '🌙 <b>Quiet hours ' + hh(quiet.from) + '–' + hh(quiet.to) + '</b>. Emails still come, but without sound. ' +
      'Only 🔴 urgent insurance rings.\n\nChange: /quiet 23-6 · Turn off: /quiet off'
    : '🔔 Quiet hours are off: every email rings.\n\nTurn on: /quiet 22-7', TRASH)
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
    } else if (act === 'e' || act === 'z' || act === 'w' || act === 'x') {
      toast = await onFilterButton(q, act === 'x' ? 'z' : act, a)
    } else if (act === 'q') {
      const { data: gone } = await db.from('mailbot_muted').delete().eq('id', Number(a)).select('entry').maybeSingle()
      if (gone) toast = 'Back on: ' + describeMute(gone.entry)
      const list = await mutedList()
      await edit(chat, messageId, list.text, list.markup)
    } else if (act === 'P') {
      const { data: gone } = await db.from('mailbot_people').delete().eq('id', Number(a)).select('entry, name')
        .maybeSingle()
      if (gone) toast = 'Removed ' + (gone.name || gone.entry)
      const list = await peopleList()
      await edit(chat, messageId, list.text, list.markup)
    } else if (act === 'L') {
      const { data: gone } = await db.from('mailbot_senders').delete().eq('id', Number(a)).select('entry').maybeSingle()
      if (gone) toast = 'Forgot ' + gone.entry + '. Their next money email asks again.'
      const list = await sendersList()
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
      await clearUnanswered(ib.id, m.threadId)
      return 'Archived in Gmail'
    }
    case 'Z':
      return await stopDeadline(q, ib, id, cfg)
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
      const ctx = await loadCtx(cfg)
      const card = renderCard(ib, email, ctx, 'min', '', await deadlineOf(ib, email, ctx))
      await edit(chat, messageId, card.text, card.markup)
      return 'Back on'
    }
    case 'G':
    case 'B': {
      // ✓ Allow / ✕ Not money: the answer for this sender's company (or address, for free mail).
      const email = await fetchEmail(ib, id)
      const entry = senderEntry(email.from.email)
      await db.from('mailbot_senders').upsert({ entry, status: act === 'G' ? 'allowed' : 'denied' }, { onConflict: 'entry' })
      if (act === 'B') {
        await remove(chat, messageId)
        return entry + ': money emails go to the daily list. /senders to change it.'
      }
      const ctx = await loadCtx(cfg)
      const card = renderCard(ib, email, ctx, 'min', '', await deadlineOf(ib, email, ctx))
      await edit(chat, messageId, card.text, card.markup)
      return '✓ ' + entry + ' allowed: their money emails come here now.'
    }
    case 'R': {
      // The prompt carries the email's Gmail link, so the answer typed under it finds the email.
      const email = readEmail(await gmail(ib, `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`))
      await send(chat, '↩️ <b>Reply to ' + esc(email.from.label) + '</b>\n' +
        'Re: <a href="' + esc(gmailLink(ib.email, email.id)) + '">' + esc(clip(email.subject || '(no subject)', 200)) +
        '</a>\n\nType your answer below. You\'ll see it before it goes out.',
        { force_reply: true, input_field_placeholder: 'Your reply…' }, messageId)
      return ''
    }
    case 'o':
      await postCard(ib, await fetchEmail(ib, id), chat, await loadCtx(cfg), 'more')
      return ''
    case 'T':
      await tg('editMessageReplyMarkup', {
        chat_id: chat,
        message_id: messageId,
        reply_markup: laterKeyboard(ib.id, id, new Date(), cfg.time_zone || DEFAULT_TIME_ZONE),
      })
      return ''
    case 'W': {
      // ⏰: the card leaves the chat and comes back at the chosen time.
      const tz = cfg.time_zone || DEFAULT_TIME_ZONE
      const now = new Date()
      const due = laterTime(kind ?? 'h', now, tz)
      const m = await gmail(ib, `messages/${id}?format=minimal`)
      const { error } = await db.from('mailbot_reminders').insert({
        kind: 'later',
        inbox_id: ib.id,
        message_id: id,
        thread_id: m.threadId,
        due_at: due.toISOString(),
      })
      if (error) throw new Error('reminder: ' + error.message)
      await remove(chat, messageId)
      // You picked when it comes back, so no "⏳ No reply yet" for it on top.
      await clearUnanswered(ib.id, m.threadId)
      return '⏰ It comes back ' + fmtWhen(due, now, tz) + '.'
    }
  }
  return ''
}

// -------------------------------------------------------------- deadlines --

/**
 * The email's 📅 due date, or null when it has none or you stopped its
 * reminders (✕ Wrong date / ✓ Done leave an "off" row for the conversation).
 * If that row can't be checked, the date still shows: better than no card.
 */
async function deadlineOf(ib: Inbox, email: Email, ctx: Ctx): Promise<Day | null> {
  const day = findDeadline(email, new Date(), ctx.tz)
  if (!day) return null
  const { data, error } = await db.from('mailbot_reminders').select('id').eq('kind', 'deadline').eq('inbox_id', ib.id)
    .eq('thread_id', email.threadId).eq('note', 'off').limit(1)
  if (error) {
    console.error('deadline off check', ib.email, email.id, error.message)
    return day
  }
  return data?.length ? null : day
}

/** Saves the 📅 reminders for a new email's due date: 3 days before and on the day, at 9:00. */
async function scheduleDeadline(ib: Inbox, email: Email, day: Day, tz: string): Promise<void> {
  // One row at a time, so a time that is already saved doesn't stop the other one.
  for (const t of deadlineTimes(day, new Date(), tz)) {
    const { error } = await db.from('mailbot_reminders').insert({
      kind: 'deadline',
      inbox_id: ib.id,
      message_id: email.id,
      thread_id: email.threadId,
      due_at: t.toISOString(),
      note: dayKey(day),
    })
    // 23505: this conversation already has a reminder at that time (an earlier email in it said the same date).
    if (error && error.code !== '23505') console.error('deadline reminder', ib.email, email.id, error.message)
  }
}

/** A 📅 reminder that is due: the card comes back marked "📅 Reminder", with ✓ Done. */
async function sendDeadline(ib: Inbox, r: Reminder, chat: string, ctx: Ctx): Promise<void> {
  const email = await fetchEmail(ib, r.message_id)
  // Stopped meanwhile (✕ Wrong date while this one waited for a retry), or the date passed: nothing to remind.
  if (!(await deadlineOf(ib, email, ctx))) return
  await postCard(ib, email, chat, ctx, 'min', '📅 Reminder', { done: true })
}

/** ✕ Wrong date / ✓ Done: no more 📅 reminders for this conversation, and the card loses its 📅 line. */
// deno-lint-ignore no-explicit-any
async function stopDeadline(q: any, ib: Inbox, id: string, cfg: Config): Promise<string> {
  const { threadId } = await gmail(ib, `messages/${id}?format=minimal`)
  const { error: gone } = await db.from('mailbot_reminders').delete().eq('kind', 'deadline').eq('inbox_id', ib.id)
    .eq('thread_id', threadId)
  if (gone) throw new Error('reminders: ' + gone.message)
  // The "off" row keeps new emails in this conversation from bringing the date back.
  // Its time is 'infinity', so the reminder run never picks it up.
  const { error } = await db.from('mailbot_reminders').insert({
    kind: 'deadline',
    inbox_id: ib.id,
    message_id: id,
    thread_id: threadId,
    due_at: 'infinity',
    note: 'off',
  })
  if (error && error.code !== '23505') throw new Error('reminders: ' + error.message)
  await showCard(q, ib, id, 'min', cfg)
  return 'No more reminders for this date.'
}

// -------------------------------------------------------------- reminders --

/**
 * Sends the reminders that are due: ⏰ cards come back. Each is claimed by
 * deleting its row first, so overlapping runs never send it twice. A failure
 * puts it back for another try in 10 minutes, up to 3 times; an email that is
 * gone from Gmail just drops its reminder.
 */
async function runReminders(cfg: Config): Promise<void> {
  const chat = cfg.owner_chat_id
  // note "off": a deadline you stopped (✕ Wrong date / ✓ Done); those rows are never sent.
  const { data, error } = await db.from('mailbot_reminders').select('*').lte('due_at', new Date().toISOString())
    .neq('note', 'off').order('due_at').limit(20)
  if (error) throw new Error('reminders: ' + error.message)
  if (!data?.length) return
  const ctx = await loadCtx(cfg)
  // Several "no reply yet" cards at once: only the first one rings.
  const run = { rang: false }
  for (const r of data as Reminder[]) {
    const { data: mine } = await db.from('mailbot_reminders').delete().eq('id', r.id).select('id').maybeSingle()
    if (!mine) continue
    try {
      const ib = await inboxById(r.inbox_id)
      if (r.kind === 'later') await postCard(ib, await fetchEmail(ib, r.message_id), chat, ctx, 'min', '⏰ Reminder')
      else if (r.kind === 'deadline') await sendDeadline(ib, r, chat, ctx)
      else if (r.kind === 'unanswered') await sendUnanswered(ib, r, chat, ctx, run)
    } catch (e) {
      if (e instanceof GmailError && e.status === 404) continue
      console.error('reminder', r.id, e)
      if (r.tries < 3) {
        const { id: _id, ...again } = r
        await db.from('mailbot_reminders').insert({
          ...again,
          tries: r.tries + 1,
          due_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        })
      }
    }
  }
}

// -------------------------------------------------------- nobody answered --

/**
 * For a ⭐ or 📌 email from a real person: check in 4 working hours whether anyone answered.
 * One check per conversation, so a newer email in it replaces the old check. The clock starts
 * now (a 📌 email may be old), but a reply counts from the email's own time, kept in `note`.
 */
async function scheduleUnanswered(ib: Inbox, email: Email, ctx: Ctx, tagged: boolean): Promise<void> {
  if (!tagged && !personFor(ctx.people, email.from.email)) return
  if (isNoReply(email.from.email) || email.from.email === ib.email) return
  // The index on (inbox_id, thread_id) is partial, so PostgREST can't upsert on it: delete, then insert.
  await clearUnanswered(ib.id, email.threadId)
  const { error } = await db.from('mailbot_reminders').insert({
    kind: 'unanswered',
    inbox_id: ib.id,
    message_id: email.id,
    thread_id: email.threadId,
    due_at: addWorkingHours(new Date(), 4, ctx.tz).toISOString(),
    note: String(email.date.getTime()),
  })
  // 23505: another mail check saved one for this conversation at the same moment. One is enough.
  if (error && error.code !== '23505') console.error('unanswered', ib.email, email.id, error.message)
}

/**
 * A due "nobody answered" check: if no reply went out since the email and it is still in the
 * inbox, the card comes back marked "⏳ No reply yet". Gmail and Telegram errors throw, so
 * runReminders tries again.
 */
async function sendUnanswered(ib: Inbox, r: Reminder, chat: string, ctx: Ctx, run: { rang: boolean }): Promise<void> {
  const thread: { messages?: { id: string; labelIds?: string[]; internalDate?: string }[] } =
    await gmail(ib, `threads/${r.thread_id}?format=minimal`)
  if (answeredAfter(thread, Number(r.note))) return
  // Archived or binned in Gmail: you already dealt with it there.
  const labels = thread.messages?.find((m) => m.id === r.message_id)?.labelIds ?? []
  if (!labels.includes('INBOX') || labels.includes('TRASH') || labels.includes('SPAM')) return
  await postCard(ib, await fetchEmail(ib, r.message_id), chat, ctx, 'min', '⏳ No reply yet', { quiet: run.rang })
  run.rang = true
}

/** No "nobody answered" check for this conversation: it was archived, or a newer email starts a new one. */
async function clearUnanswered(inboxId: number, threadId: string): Promise<void> {
  const { error } = await db.from('mailbot_reminders').delete().eq('kind', 'unanswered').eq('inbox_id', inboxId)
    .eq('thread_id', threadId)
  if (error) console.error('unanswered clear', inboxId, threadId, error.message)
}

// ---------------------------------------------------------------- filters --

function describeFilter(ib: Inbox): string {
  if (ib.mode === 'all') return 'all emails'
  return 'templates' + (ib.keywords?.length ? ' + your words: ' + ib.keywords.join(', ') : ' only')
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

/**
 * Sets what the target inboxes send to Telegram: "all" for every email,
 * "templates" for template emails only, or words that also let other emails
 * through (they replace the old words).
 */
async function applyFilter(chat: string, target: string, input: string): Promise<void> {
  const inboxes = await filterTargets(target)
  if (!inboxes.length) {
    await send(chat, 'That inbox is no longer connected. See /inboxes')
    return
  }
  const all = /^\s*(all|все)\s*$/i.test(input)
  const rules = all || /^\s*(templates|none|off)\s*$/i.test(input) ? [] : parseRules(input)
  await db.from('mailbot_inboxes').update({ keywords: rules, mode: all ? 'all' : 'templates' })
    .in('id', inboxes.map((ib) => ib.id))
  const who = '<b>' + esc(target === 'all' ? 'All inboxes' : inboxes[0].email) + '</b>'
  if (all) {
    await send(chat, '✅ ' + who + ': you get every email now. Templates still mark the ones they know.', TRASH)
    return
  }
  await send(chat, [
    '✅ ' + who + ': you get the template emails (🔴 💰 🧾 ⭐)' + (rules.length ? ', and emails that have' : ' only.'),
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
    '✏️ <b>' + esc(who) + '</b>',
    ...(target === 'all' ? [] : ['Now: ' + esc(describeFilter(inboxes[0]))]),
    '',
    'Template emails always come through (🔴 💰 🧾 ⭐, see /templates).',
    'To also get other emails with certain words, type them in one message:',
    'Commas, if any word is enough: <code>erbol, load 4411</code>',
    'Plus, if both words must be there: <code>broker + rate</code>',
    'The new words replace the old ones.',
  ].join('\n'), {
    inline_keyboard: [[
      { text: '📋 Templates only', callback_data: 'w:' + target },
      { text: '🌐 All emails', callback_data: 'z:' + target },
    ]],
  })
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
  const lines = ['🏷 <b>What comes to Telegram</b>', '',
    ...inboxes.map((ib) => esc(ib.email) + ': ' + esc(describeFilter(ib))), '',
    'Tap an inbox to change it: templates only, extra words, or all emails. /templates shows the template words.']
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
  await applyFilter(chat, target, act === 'w' ? 'templates' : 'all')
  return act === 'w' ? 'Templates only' : 'All emails'
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
    '📋 <b>' + rows.length + ' emails fit no template</b>' + (rows.length > shown.length ? ' (latest ' + shown.length + ' here)' : ''),
    'Anything important? Add the sender with /people, or a word with /filter.',
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
  // The "↩️ Reply to …" prompt has done its job; the confirmation shows what was typed.
  const prompt = m.reply_to_message
  if (prompt.from?.is_bot && String(prompt.text ?? '').startsWith('↩️ Reply to')) {
    await tg('deleteMessage', { chat_id: chat, message_id: prompt.message_id })
  }
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
  else background(tick(cfg))
  return json({ ok: true })
}

/**
 * The once-a-minute work: new mail first, then reminders. A failure in one
 * never stops the other. If the last minute's check is still running, this one
 * steps aside instead of racing it over the same emails.
 */
async function tick(cfg: Config): Promise<void> {
  const lock = await takeLock()
  if (!lock) return
  try {
    try {
      await pollAll(cfg)
    } catch (e) {
      console.error('cron', e)
    }
    try {
      await runReminders(cfg)
    } catch (e) {
      console.error('reminders', e)
    }
  } finally {
    await dropLock(lock)
  }
}

/**
 * One mail check at a time (the minute's run or /check). The lock is the
 * mailbot_config row "run_lock" holding when it runs out, so a check that was
 * cut off frees it by itself. Returns that time, or null if it's taken.
 */
async function takeLock(): Promise<string | null> {
  const until = new Date(Date.now() + LOCK_MS).toISOString()
  const { data } = await db.from('mailbot_config').update({ value: until })
    .eq('key', 'run_lock').lt('value', new Date().toISOString()).select('key')
  if (data?.length) return until
  // The very first time there is no row yet.
  const { data: made } = await db.from('mailbot_config')
    .upsert({ key: 'run_lock', value: until }, { onConflict: 'key', ignoreDuplicates: true }).select('key')
  return made?.length ? until : null
}

async function dropLock(until: string): Promise<void> {
  await db.from('mailbot_config').update({ value: '' }).eq('key', 'run_lock').eq('value', until)
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
