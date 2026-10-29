import 'jsr:@supabase/functions-js@2/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  base64urlToBytes,
  buildReply,
  cardText,
  clip,
  decodeEntities,
  type Email,
  emailKeyboard,
  esc,
  fmtDate,
  gmailLink,
  isMuted,
  matchRules,
  parseRules,
  readableBody,
  readEmail,
  refFromEntities,
  shouldSkip,
  similarWords,
  type Attachment,
  type Button,
} from './mail.ts'

/**
 * Mail bot: posts new mail from every connected inbox to one Telegram chat and
 * acts on it from there (read, archive, full text, attachments, mute, reply).
 * Each inbox connects with Google sign-in; nothing is forwarded anywhere.
 *
 * Routes. verify_jwt is off because Telegram and Google call in without a
 * Supabase JWT, so every route checks its own secret:
 *   POST /telegram  Telegram webhook, checked against X-Telegram-Bot-Api-Secret-Token
 *   GET  /connect   short link from /connect that redirects to Google's consent screen
 *   GET  /callback  Google's OAuth redirect
 *   POST /cron      pg_cron once a minute, bearer token from mailbot_config
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
const PREVIEW_CHARS = 1200
const MAX_EMAILS_PER_RUN = 15
const MAX_ATTACHMENTS = 10
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const EXPIRY_MARGIN_MS = 60_000
const DEFAULT_TIME_ZONE = 'Asia/Bishkek'
const FILTER_WAIT_MS = 10 * 60_000
const DIGEST_ITEMS = 20

const HELP = [
  '<b>Команды</b>',
  '/connect: добавить почту (вход через Google)',
  '/inboxes: подключённые почты',
  '/disconnect name@company.com: отключить почту',
  '/unread: последние непрочитанные письма',
  '/filter: присылать только письма с нужными словами (payment, erbol, payment + insurance)',
  '/skipped: письма, которые фильтры не пропустили',
  '/check: проверить все почты прямо сейчас',
  '/mute name@company.com или company.com: не показывать письма от человека или компании',
  '/unmute, /muted: вернуть или посмотреть заглушённых',
  '/pause, /resume: выключить или включить уведомления',
  '/status: всё ли работает',
  '',
  'Чтобы ответить на письмо, нажми «Ответить» на нём в Telegram и напиши текст. Я покажу ответ перед отправкой.',
].join('\n')

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

type Config = Record<string, string>

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
  if (!data) throw new Error('эта почта больше не подключена')
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
    if (!body.ok) console.error('telegram', method, body.description)
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
  if (!refresh) throw new Error('нет сохранённого доступа для ' + ib.email)
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
        await send(chat, '⚠️ Google отключил <b>' + esc(ib.email) + '</b> (доступ отозван или сменён пароль). ' +
          'Отправь /connect, чтобы войти снова.')
      }
    }
    throw new Error('не удалось обновить доступ для ' + ib.email + ': ' + (t.error ?? 'unknown'))
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
        await send(chat, '⚠️ Не получилось проверить <b>' + esc(ib.email) + '</b>: ' + esc(message))
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
  if (isMuted(muted, email.from.email)) return false
  const filter = matchRules(email, ib.keywords)
  if (!filter.pass) {
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
  await postEmail(ib, email, chat, tz, filter.tags)
  return true
}

async function postEmail(ib: Inbox, email: Email, chat: string, tz: string, tags: string[] = []): Promise<void> {
  const link = gmailLink(ib.email, email.id)
  const text = cardText({
    inbox: ib.label || ib.email,
    email,
    link,
    preview: clip(readableBody(email, true), PREVIEW_CHARS),
    timeZone: tz,
    tags,
  })
  const res = await send(chat, text, emailKeyboard(ib.id, email.id, link, email.labelIds.includes('UNREAD'), false))
  if (!res.ok) throw new TelegramError(res)
  for (const file of email.attachments.slice(0, MAX_ATTACHMENTS)) {
    try {
      await sendAttachment(ib, email, file, link, chat, res.result.message_id)
    } catch (e) {
      console.error('attachment', file.name, e)
      await send(chat, '📎 Не получилось отправить ' + esc(file.name) + '. <a href="' + esc(link) + '">Открыть в Gmail</a>',
        undefined, res.result.message_id)
    }
  }
}

async function sendAttachment(ib: Inbox, email: Email, file: Attachment, link: string, chat: string, replyTo: number) {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    await send(chat, '📎 ' + esc(file.name) + ': ' + Math.round(file.size / 1048576) + ' МБ, слишком большой для Telegram. ' +
      '<a href="' + esc(link) + '">Открыть в Gmail</a>', undefined, replyTo)
    return
  }
  const data = file.data ?? (await gmail(ib, `messages/${email.id}/attachments/${file.attachmentId}`)).data
  const form = new FormData()
  form.set('chat_id', chat)
  form.set('document', new Blob([base64urlToBytes(data)], { type: file.mimeType }), file.name)
  // The caption link lets you reply to an attachment just like to its email.
  form.set('caption', '📎 <a href="' + esc(link) + '">' + esc(file.name) + '</a>')
  form.set('parse_mode', 'HTML')
  form.set('reply_parameters', JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }))
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
      await send(chat, '✅ Бот теперь твой.\n\nДобавь свои почты: отправь /connect, войди в одну почту ' +
        'и повтори для каждой.\n\n' + HELP)
    }
    return
  }
  if (chat !== owner) return

  if (cfg.awaiting_filter && m.reply_to_message) await db.from('mailbot_config').delete().eq('key', 'awaiting_filter')
  if (text.startsWith('/')) await onCommand(cfg, chat, text)
  else if (m.reply_to_message) await onReply(chat, m, text)
  else if (!(await applyAwaitedFilter(cfg, chat, text))) await send(chat, 'Чтобы ответить на письмо, нажми «Ответить» на нём. Все команды: /help')
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
        await send(chat, '⏸ Уведомления выключены. Сначала /resume.')
        return
      }
      if (!(await pollAll(cfg))) await send(chat, '📭 Новых писем нет.')
      return
    }
    case '/mute':
      return await cmdMute(chat, arg, true)
    case '/unmute':
      return await cmdMute(chat, arg, false)
    case '/muted': {
      const muted = await loadMuted()
      await send(chat, muted.length ? '🔇 Заглушены:\n' + esc(muted.join('\n')) : 'Никто не заглушён.')
      return
    }
    case '/pause':
      await setConfig('paused', 'true')
      await send(chat, '⏸ Уведомления выключены. /resume включит их снова.')
      return
    case '/resume':
      await setConfig('paused', 'false')
      // Fresh cursors: what arrived while paused is skipped, not dumped into the chat at once.
      await db.from('mailbot_inboxes').update({ history_id: null }).eq('status', 'connected')
      await send(chat, '▶️ Уведомления включены. Что пришло за паузу, покажет /unread.')
      return
    case '/status':
      return await cmdStatus(cfg, chat)
    default:
      await send(chat, HELP)
  }
}

async function cmdConnect(chat: string, hint: string): Promise<void> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    await send(chat, 'Вход через Google не настроен на сервере (нет GOOGLE_CLIENT_ID).')
    return
  }
  const state = randomToken(18)
  await db.from('mailbot_oauth_states').insert({ state, code_verifier: randomToken(48), login_hint: hint || null })
  await db.from('mailbot_oauth_states').delete().lt('expires_at', new Date().toISOString())
  const link = `${FN_URL}/connect?s=${state}`
  await send(chat, '🔐 Нажми кнопку, войди в почту, которую хочешь добавить, и разреши доступ.\n\n' +
    'Если Google не открывается внутри Telegram, скопируй эту ссылку в Safari или Chrome:\n' + esc(link) +
    '\n\nСсылка работает один раз, 15 минут.', {
    inline_keyboard: [[{ text: '🔐 Войти через Google', url: link }]],
  })
}

async function cmdInboxes(chat: string): Promise<void> {
  const { data } = await db.from('mailbot_inboxes').select('email, status, last_error, keywords').order('id')
  if (!data?.length) {
    await send(chat, 'Почт пока нет. Отправь /connect, чтобы добавить.')
    return
  }
  const lines = data.map((r) =>
    (r.status !== 'connected'
      ? '⚠️ ' + esc(r.email) + ': вышла из аккаунта, подключи снова через /connect'
      : (r.last_error ? '⚠️ ' : '✅ ') + esc(r.email) + (r.last_error ? ': ' + esc(clip(r.last_error, 120)) : '')) +
    ' · 🏷 ' + esc(describeFilter(r as Inbox))
  )
  lines.push('', '/connect добавит ещё одну. /disconnect name@company.com отключит.')
  await send(chat, lines.join('\n'))
}

async function cmdDisconnect(chat: string, arg: string): Promise<void> {
  const email = arg.toLowerCase()
  const { data: ib } = await db.from('mailbot_inboxes').select('id').eq('email', email).maybeSingle()
  if (!ib) {
    await send(chat, 'Напиши так: /disconnect name@company.com (список: /inboxes)')
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
  await send(chat, '🗑 ' + esc(email) + ' отключена.')
}

async function cmdUnread(cfg: Config, chat: string): Promise<void> {
  const inboxes = await connectedInboxes()
  if (!inboxes.length) {
    await send(chat, 'Почты ещё не подключены. Отправь /connect.')
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
        .filter((x) => !isMuted(muted, x.email.from.email) && matchRules(x.email, ib.keywords).pass)
    } catch (e) {
      console.error('unread', ib.email, e)
      return []
    }
  }))
  const items = lists.flat().sort((a, b) => b.email.date.getTime() - a.email.date.getTime()).slice(0, 10)
  if (!items.length) {
    await send(chat, '📭 Непрочитанных писем нет.')
    return
  }
  const tz = cfg.time_zone || DEFAULT_TIME_ZONE
  const lines = ['📬 <b>Непрочитанные</b> (примерно ' + total + '). Сначала новые. Нажми номер, чтобы открыть письмо здесь.', '']
  const buttons: Button[] = []
  items.forEach(({ ib, email }, i) => {
    lines.push((i + 1) + '. <a href="' + esc(gmailLink(ib.email, email.id)) + '">' +
      esc(clip(email.subject || '(без темы)', 80)) + '</a>')
    lines.push('     ' + esc(email.from.label) + ' · ' + esc(ib.label || ib.email) + ' · ' + fmtDate(email.date, tz))
    buttons.push({ text: String(i + 1), callback_data: `o:${ib.id}:${email.id}` })
  })
  const rows: Button[][] = []
  for (let i = 0; i < buttons.length; i += 5) rows.push(buttons.slice(i, i + 5))
  await send(chat, lines.join('\n'), { inline_keyboard: rows })
}

async function cmdMute(chat: string, arg: string, on: boolean): Promise<void> {
  const entry = arg.toLowerCase().replace(/^@/, '')
  if (!/^([^\s@]+@)?[^\s@]+\.[^\s@]+$/.test(entry)) {
    await send(chat, 'Напиши так: /' + (on ? 'mute' : 'unmute') + ' name@company.com или company.com')
    return
  }
  if (on) await db.from('mailbot_muted').upsert({ entry })
  else await db.from('mailbot_muted').delete().eq('entry', entry)
  await send(chat, (on ? '🔇 Заглушён: ' : '🔔 Снова показываю: ') + esc(entry))
}

async function cmdStatus(cfg: Config, chat: string): Promise<void> {
  const { data } = await db.from('mailbot_inboxes').select('status, last_error, last_checked_at')
  const rows = data ?? []
  const connected = rows.filter((r) => r.status === 'connected')
  const failing = connected.filter((r) => r.last_error).length
  const signedOut = rows.length - connected.length
  const last = connected.map((r) => Date.parse(r.last_checked_at ?? '') || 0).sort()[0]
  await send(chat, [
    cfg.paused === 'true' ? '⏸ На паузе' : '✅ Работает, проверяю каждую минуту',
    'Почты: подключено ' + connected.length + (failing ? ', с ошибкой ' + failing : '') +
      (signedOut ? ', вышли из аккаунта ' + signedOut : ''),
    'Самая давняя проверка: ' + (last ? Math.round((Date.now() - last) / 60_000) + ' мин назад' : 'ещё не было'),
    'Заглушено: ' + (await loadMuted()).length,
  ].join('\n'))
}

// deno-lint-ignore no-explicit-any
async function onCallback(cfg: Config, q: any): Promise<void> {
  const chat = String(q.message.chat.id)
  const [act, a, b] = String(q.data ?? '').split(':')
  let toast = ''
  try {
    if (act === 'e' || act === 'x') {
      toast = await onFilterButton(q, act, a)
    } else if (b && 'rafmo'.includes(act)) {
      const ib = await inboxById(Number(a))
      switch (act) {
        case 'r':
          await gmail(ib, `messages/${b}/modify`, { removeLabelIds: ['UNREAD'] })
          await refreshKeyboard(q, ib, b, false)
          toast = 'Отмечено как прочитанное'
          break
        case 'a': {
          const m = await gmail(ib, `messages/${b}?format=minimal`)
          await gmail(ib, `threads/${m.threadId}/modify`, { removeLabelIds: ['INBOX', 'UNREAD'] })
          await refreshKeyboard(q, ib, b, true)
          toast = 'В архиве'
          break
        }
        case 'f':
          await sendFullText(chat, ib, b, q.message.message_id)
          break
        case 'm': {
          const sender = readEmail(await gmail(ib, `messages/${b}?format=metadata&metadataHeaders=From`)).from.email
          await db.from('mailbot_muted').upsert({ entry: sender })
          await send(chat, '🔇 Заглушён: ' + esc(sender) + '. Отменить: /unmute ' + esc(sender))
          toast = 'Заглушён'
          break
        }
        case 'o': {
          const email = readEmail(await gmail(ib, `messages/${b}?format=full`))
          await postEmail(ib, email, chat, cfg.time_zone || DEFAULT_TIME_ZONE,
            matchRules(email, ib.keywords).tags)
          break
        }
      }
    } else if (act === 'y' || act === 'Y') {
      toast = await sendPendingReply(chat, a, act === 'Y', q.message.message_id)
    } else if (act === 'n') {
      await db.from('mailbot_pending_replies').delete().eq('key', a)
      await tg('editMessageText', { chat_id: chat, message_id: q.message.message_id, text: '✖ Ответ отменён.' })
    }
  } catch (e) {
    console.error('callback', q.data, e)
    toast = 'Ошибка: ' + errorText(e)
  }
  await tg('answerCallbackQuery', { callback_query_id: q.id, text: toast.slice(0, 190) })
}

// deno-lint-ignore no-explicit-any
async function refreshKeyboard(q: any, ib: Inbox, id: string, archived: boolean): Promise<void> {
  const rows: Button[][] = q.message.reply_markup?.inline_keyboard ?? []
  const wasArchived = !rows.some((row) => row.some((btn) => btn.callback_data === `a:${ib.id}:${id}`))
  await tg('editMessageReplyMarkup', {
    chat_id: q.message.chat.id,
    message_id: q.message.message_id,
    reply_markup: emailKeyboard(ib.id, id, gmailLink(ib.email, id), false, archived || wasArchived),
  })
}

async function sendFullText(chat: string, ib: Inbox, id: string, replyTo: number): Promise<void> {
  const text = readableBody(readEmail(await gmail(ib, `messages/${id}?format=full`)), false) || '(пустое письмо)'
  const size = 3800
  for (let i = 0; i < text.length && i < size * 4; i += size) {
    await send(chat, esc(text.slice(i, i + size)), undefined, replyTo)
  }
  if (text.length > size * 4) {
    await send(chat, '…остальное в <a href="' + esc(gmailLink(ib.email, id)) + '">Gmail</a>.', undefined, replyTo)
  }
}

// ---------------------------------------------------------------- filters --

function describeFilter(ib: Inbox): string {
  return ib.keywords?.length ? ib.keywords.join(', ') : 'все письма'
}

/** A rule as the user should read it: "payment (и похожие: pay, paid, invoice…) + insurance (…)". */
function describeRule(rule: string): string {
  return rule.split(' + ').map((w) => {
    const similar = similarWords(w)
    return similar.length ? w + ' (и похожие: ' + similar.slice(0, 5).join(', ') + '…)' : w
  }).join(' + ')
}

/** The inboxes a filter target names: one inbox id, or "all". */
async function filterTargets(target: string): Promise<Inbox[]> {
  const { data } = await db.from('mailbot_inboxes').select('*').order('id')
  const inboxes = (data ?? []) as Inbox[]
  return target === 'all' ? inboxes : inboxes.filter((ib) => String(ib.id) === target)
}

/** Replaces the target inboxes' rules with what the user typed; "все" / "off" removes the filter. */
async function applyFilter(chat: string, target: string, input: string): Promise<void> {
  const inboxes = await filterTargets(target)
  if (!inboxes.length) {
    await send(chat, 'Эта почта больше не подключена. Список: /inboxes')
    return
  }
  const rules = /^\s*(off|all|все|выкл|нет)\s*$/i.test(input) ? [] : parseRules(input)
  await db.from('mailbot_inboxes').update({ keywords: rules }).in('id', inboxes.map((ib) => ib.id))
  const who = target === 'all' ? 'всех почт' : inboxes[0].email
  if (!rules.length) {
    await send(chat, '✅ С ' + esc(who) + ' теперь приходят все письма.')
    return
  }
  await send(chat, [
    '✅ С <b>' + esc(who) + '</b> теперь приходят только письма, где есть:',
    ...rules.map((r) => '• ' + esc(describeRule(r))),
    '',
    'Остальные не пропадут: раз в день пришлю список отсеянного. Посмотреть сейчас: /skipped',
  ].join('\n'))
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
    await send(chat, 'Эта почта больше не подключена. Список: /inboxes')
    return
  }
  await setConfig('awaiting_filter', target + '|' + Date.now())
  const who = target === 'all' ? 'всех почт сразу' : inboxes[0].email
  await send(chat, [
    '✏️ Напиши слова для <b>' + esc(who) + '</b> одним сообщением.',
    ...(target === 'all' ? [] : ['Сейчас: ' + esc(describeFilter(inboxes[0]))]),
    '',
    'Письмо придёт, если в нём есть хотя бы одно правило.',
    'Через запятую, если хватит любого: <code>payment, erbol</code>',
    'С плюсом, если нужны оба слова: <code>payment + insurance</code>',
    'Похожие слова считаются сами: payment найдёт и invoice, и «оплата».',
    '',
    'Новый список заменит старый.',
  ].join('\n'), { inline_keyboard: [[{ text: '🌐 Все письма (без фильтра)', callback_data: 'x:' + target }]] })
}

async function cmdFilter(chat: string, arg: string): Promise<void> {
  const inboxes = await filterTargets('all')
  if (!inboxes.length) {
    await send(chat, 'Сначала подключи почту: /connect')
    return
  }
  if (arg) {
    const [first, ...rest] = arg.split(/\s+/)
    const target = /^(all|все)$/i.test(first)
      ? 'all'
      : String(inboxes.find((ib) => ib.email === first.toLowerCase())?.id ?? '')
    if (!target) {
      await send(chat, 'Напиши так: /filter name@gmail.com payment, erbol\nИли просто /filter и выбери почту.')
      return
    }
    const words = rest.join(' ').trim()
    return words ? await applyFilter(chat, target, words) : await askFilterWords(chat, target)
  }
  const lines = ['🏷 <b>Фильтры</b>', '', ...inboxes.map((ib) => esc(ib.email) + ': ' + esc(describeFilter(ib))), '',
    'Нажми на почту и напиши слова. Письма без этих слов в Telegram не придут.']
  const rows: Button[][] = inboxes.map((ib) => [{ text: '✏️ ' + ib.email, callback_data: 'e:' + ib.id }])
  if (inboxes.length > 1) rows.push([{ text: '✏️ Все почты сразу', callback_data: 'e:all' }])
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
  await applyFilter(chat, target, 'все')
  return 'Фильтр убран'
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
    if (!scheduled) await send(chat, '📭 Фильтры ничего не отсеяли.')
    return
  }
  const { data: inboxes } = await db.from('mailbot_inboxes').select('id, email')
  const emailOf = new Map((inboxes ?? []).map((ib) => [ib.id, ib.email]))
  const tz = cfg.time_zone || DEFAULT_TIME_ZONE
  const shown = rows.slice(0, DIGEST_ITEMS)
  const lines = [
    '📋 <b>Фильтры отсеяли ' + rows.length + '</b>' + (rows.length > shown.length ? ' (здесь последние ' + shown.length + ')' : ''),
    'Глянь, нет ли важного. Если есть, добавь слово через /filter.',
    '',
  ]
  for (const r of shown) {
    const inbox = emailOf.get(r.inbox_id) ?? ''
    lines.push('• <a href="' + esc(gmailLink(inbox, r.message_id)) + '">' + esc(clip(r.subject || '(без темы)', 60)) + '</a>')
    lines.push('   ' + esc(clip(r.sender, 30)) + ' · ' + esc(inbox) + ' · ' + fmtDate(new Date(r.received_at), tz))
  }
  const res = await send(chat, lines.join('\n'))
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
    await send(chat, 'Чтобы ответить, нажми «Ответить» на сообщении с одним письмом.')
    return
  }
  if (!text) {
    await send(chat, 'Пока можно отвечать только текстом.')
    return
  }
  const { data: ib } = await db.from('mailbot_inboxes').select('*').eq('email', ref.inbox).maybeSingle()
  if (!ib) {
    await send(chat, esc(ref.inbox) + ' больше не подключена. Сначала /connect.')
    return
  }
  const email = readEmail(await gmail(ib as Inbox, `messages/${ref.id}?format=metadata&${REPLY_HEADERS}`))
  const one = buildReply(email, ib.email, text, false)
  const all = buildReply(email, ib.email, text, true)
  const key = randomToken(9)
  await db.from('mailbot_pending_replies').insert({ key, inbox_id: ib.id, message_id: ref.id, body: text })
  await db.from('mailbot_pending_replies').delete().lt('created_at', new Date(Date.now() - 86_400_000).toISOString())

  const lines = ['↩️ <b>Кому:</b> ' + esc(one.to.join(', ')), '<b>От:</b> ' + esc(ib.email)]
  if (all.cc.length) lines.push('<b>«Ответить всем» добавит:</b> ' + esc(all.cc.join(', ')))
  lines.push('', esc(text))
  const buttons: Button[] = [{ text: '✅ Отправить', callback_data: 'y:' + key }]
  if (all.cc.length) buttons.push({ text: '👥 Ответить всем', callback_data: 'Y:' + key })
  buttons.push({ text: '✖ Отмена', callback_data: 'n:' + key })
  await send(chat, lines.join('\n'), { inline_keyboard: [buttons] }, m.message_id)
}

async function sendPendingReply(chat: string, key: string, all: boolean, confirmId: number): Promise<string> {
  // Deleting is the claim: a double tap or a Telegram retry finds nothing the second time.
  const { data: p } = await db.from('mailbot_pending_replies').delete().eq('key', key).select().maybeSingle()
  if (!p) return 'Уже отправлено или отменено'
  const ib = await inboxById(p.inbox_id)
  const email = readEmail(await gmail(ib, `messages/${p.message_id}?format=metadata&${REPLY_HEADERS}`))
  const reply = buildReply(email, ib.email, p.body, all)
  await gmail(ib, 'messages/send', { raw: reply.raw, threadId: email.threadId })
  await tg('editMessageText', {
    chat_id: chat,
    message_id: confirmId,
    text: '✅ Отправлено: ' + esc([...reply.to, ...reply.cc].join(', ')) + '\n\n' + esc(p.body),
    parse_mode: 'HTML',
  })
  return 'Отправлено'
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
    return page('Эта ссылка для входа устарела или уже использована. Отправь /connect в Telegram, чтобы получить новую.', 400)
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
    return page('Google ответил: ' + params.get('error') + '. Отправь /connect в Telegram и попробуй ещё раз.', 400)
  }
  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) return page('Не хватает данных для входа. Отправь /connect в Telegram и попробуй ещё раз.', 400)

  // Single use: deleted on read, so a replayed callback can't connect anything.
  const { data: hs } = await db.from('mailbot_oauth_states').delete().eq('state', state)
    .select('code_verifier, expires_at').maybeSingle()
  if (!hs || Date.parse(hs.expires_at) < Date.now()) {
    return page('Эта ссылка для входа устарела или уже использована. Отправь /connect в Telegram, чтобы получить новую.', 400)
  }

  const t = await postToken({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    code,
    code_verifier: hs.code_verifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  })
  if (!t.access_token) return page('Google отказал во входе: ' + (t.error_description ?? t.error) + '.', 400)
  if (!String(t.scope ?? '').includes(GMAIL_SCOPE)) {
    return page('Доступ к Gmail не выдан. Отправь /connect ещё раз и поставь галочку Gmail на экране разрешений Google.', 400)
  }
  if (!t.refresh_token) {
    return page('Google не выдал постоянный доступ. Отправь /connect ещё раз.', 400)
  }

  const profileRes = await fetch(GMAIL + 'profile', { headers: { Authorization: 'Bearer ' + t.access_token } })
  if (!profileRes.ok) {
    return page('Вход выполнен, но Gmail не дал доступ (' + profileRes.status + '). Включён ли Gmail API в Google Cloud?', 502)
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
  if (error || !row) return page('Не получилось сохранить почту: ' + (error?.message ?? 'unknown') + '.', 500)
  const { error: vaultError } = await db.rpc('mailbot_store_refresh_token', { p_inbox_id: row.id, p_token: t.refresh_token })
  if (vaultError) return page('Не получилось сохранить доступ: ' + vaultError.message + '.', 500)

  const cfg = await loadConfig()
  if (cfg.owner_chat_id) {
    await send(cfg.owner_chat_id, '✅ <b>' + esc(email) + '</b> подключена. Новые письма из неё будут приходить сюда.\n\n' +
      '/connect добавит ещё одну почту.')
  }
  if (cfg.bot_username) return Response.redirect('https://t.me/' + cfg.bot_username, 302)
  return page('✅ ' + email + ' подключена. Можно вернуться в Telegram.')
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
