/**
 * Reading Gmail API messages and writing replies. No I/O here, so this file is
 * unit-tested on its own: deno test mail-bot/test/
 */

export interface Address {
  email: string
  name: string
  label: string
}

export interface GmailPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: GmailPart[]
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  internalDate?: string
  payload?: GmailPart
}

export interface Attachment {
  name: string
  mimeType: string
  size: number
  attachmentId?: string
  data?: string
}

export interface Email {
  id: string
  threadId: string
  labelIds: string[]
  from: Address
  to: string
  cc: string
  replyTo: string
  subject: string
  date: Date
  messageId: string
  references: string
  text: string
  attachments: Attachment[]
}

// ------------------------------------------------------------- addresses --

export function parseAddress(s: string): Address {
  s = String(s || '').trim()
  const m = s.match(/^(.*?)\s*<([^<>]+)>\s*$/)
  const email = (m ? m[2] : s).trim().toLowerCase()
  const name = m ? m[1].replace(/^["'\s]+|["'\s]+$/g, '') : ''
  return { email, name, label: name || email }
}

/** Splits "A <a@x>, \"B, Jr\" <b@x>" on the commas between addresses only. */
export function parseAddressList(s: string): Address[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  let angle = false
  for (const ch of String(s || '')) {
    if (ch === '"') quoted = !quoted
    else if (ch === '<') angle = true
    else if (ch === '>') angle = false
    if (ch === ',' && !quoted && !angle) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean).map(parseAddress)
}

export function isMuted(muted: string[], email: string): boolean {
  return muted.some((m) =>
    m.includes('@') ? email === m : email.endsWith('@' + m) || email.endsWith('.' + m)
  )
}

// --------------------------------------------------------------- reading --

export function header(part: GmailPart | undefined, name: string): string {
  const lower = name.toLowerCase()
  return part?.headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? ''
}

export function base64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

export function bytesToBase64url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Gmail undoes the transfer encoding but not the charset, so Cyrillic mail in windows-1251 needs this. */
function decodeText(part: GmailPart): string {
  const bytes = base64urlToBytes(part.body?.data ?? '')
  const charset = (header(part, 'Content-Type').match(/charset="?([^";\s]+)/i) || [])[1] || 'utf-8'
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

export function readEmail(msg: GmailMessage): Email {
  const root = msg.payload ?? {}
  let plain: GmailPart | null = null
  let html: GmailPart | null = null
  const attachments: Attachment[] = []

  const walk = (part: GmailPart) => {
    const type = (part.mimeType ?? '').toLowerCase()
    const disposition = header(part, 'Content-Disposition').toLowerCase()
    const inlineImage = type.startsWith('image/') && Boolean(header(part, 'Content-ID')) &&
      !disposition.startsWith('attachment')
    if (part.filename && (part.body?.attachmentId || part.body?.data)) {
      if (!inlineImage) {
        attachments.push({
          name: part.filename,
          mimeType: part.mimeType ?? 'application/octet-stream',
          size: part.body?.size ?? 0,
          attachmentId: part.body?.attachmentId,
          data: part.body?.data,
        })
      }
      return
    }
    if (type === 'text/plain' && !plain && part.body?.data) plain = part
    else if (type === 'text/html' && !html && part.body?.data) html = part
    for (const child of part.parts ?? []) walk(child)
  }
  walk(root)

  const date = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date(header(root, 'Date') || Date.now())
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds ?? [],
    from: parseAddress(header(root, 'From')),
    to: header(root, 'To'),
    cc: header(root, 'Cc'),
    replyTo: header(root, 'Reply-To'),
    subject: header(root, 'Subject'),
    date,
    messageId: header(root, 'Message-ID') || header(root, 'Message-Id'),
    references: header(root, 'References'),
    text: plain ? decodeText(plain) : html ? htmlToText(decodeText(html)) : '',
    attachments,
  }
}

/** Mail that isn't in the inbox (sent, drafts, spam, filtered away) or sits in a skipped tab. */
export function shouldSkip(labelIds: string[], skipCategories: string[]): boolean {
  if (!labelIds.includes('INBOX')) return true
  if (labelIds.some((l) => l === 'SENT' || l === 'DRAFT' || l === 'SPAM' || l === 'TRASH')) return true
  return labelIds.some((l) => skipCategories.includes(l))
}

const QUOTE_MARKERS = [
  /^[ \t]*On\b[^\n]{0,200}(\n[^\n]{0,200})?\bwrote:[ \t]*$/m,
  /^[^\n]{0,200}(пишет|написал|написала|написал\(а\)):[ \t]*$/m,
  /^[ \t]*-{2,}[ \t]*(Original Message|Исходное сообщение|Пересылаемое сообщение)/mi,
  /^[ \t]*(From|От):[^\n]*\n[ \t]*(Sent|Date|Отправлено|Дата):/mi,
  /^[ \t]*_{20,}[ \t]*$/m,
]

/** Plain-text body; with `stripQuotes`, the quoted earlier messages are cut off (except in forwards). */
export function readableBody(email: Email, stripQuotes: boolean): string {
  let t = email.text
    .replace(/\r\n?/g, '\n')
    .replace(/<(?:https?:|mailto:)[^>\s]*>/gi, '') // "text <link>" left over from HTML mail
    .replace(/\[image:[^\]]*\]/gi, '')
    .replace(/[ \t\u00a0]+\n/g, '\n')
  if (stripQuotes && !/^\s*(fw|fwd)\s*:/i.test(email.subject)) t = stripQuoted(t)
  return t.replace(/\n{3,}/g, '\n\n').trim()
}

export function stripQuoted(text: string): string {
  let cut = text.length
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(text)
    if (m && m.index < cut) cut = m.index
  }
  const head = text.slice(0, cut).replace(/^>.*$/gm, '').trim()
  return head.length >= 20 ? head : text
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
}

function codePoint(n: number): string {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => codePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

// -------------------------------------------------------------- telegram --

export function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + ' …' : s
}

export function fmtDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
}

export function gmailLink(inbox: string, id: string): string {
  return `https://mail.google.com/mail/u/${inbox}/#all/${id}`
}

/** The inbox + Gmail ID behind an email card or attachment, or null if there isn't exactly one. */
export function refFromEntities(entities: { type: string; url?: string }[] | undefined): { inbox: string; id: string } | null {
  const refs = new Map<string, { inbox: string; id: string }>()
  for (const e of entities ?? []) {
    const m = e.type === 'text_link' && /\/mail\/u\/([^/]+)\/#all\/([0-9a-f]+)/i.exec(e.url ?? '')
    if (m) refs.set(m[1] + '/' + m[2], { inbox: decodeURIComponent(m[1]).toLowerCase(), id: m[2] })
  }
  return refs.size === 1 ? [...refs.values()][0] : null
}

export function cardText(o: { inbox: string; email: Email; link: string; preview: string; timeZone: string }): string {
  const { email } = o
  const lines = [
    '📥 <b>' + esc(o.inbox) + '</b>',
    '👤 <b>' + esc(email.from.label) + '</b>' + (email.from.name ? ' ' + esc('<' + email.from.email + '>') : ''),
    // The reply flow reads the inbox and Gmail ID back from this link.
    '✉️ <a href="' + esc(o.link) + '">' + esc(clip(email.subject || '(no subject)', 300)) + '</a>',
    '🕒 ' + fmtDate(email.date, o.timeZone),
  ]
  if (o.preview) lines.push('', esc(o.preview))
  const n = email.attachments.length
  if (n) lines.push('', '📎 ' + n + (n === 1 ? ' attachment' : ' attachments'))
  return lines.join('\n')
}

export interface Button {
  text: string
  callback_data?: string
  url?: string
}

export function emailKeyboard(inboxId: number, id: string, link: string, unread: boolean, archived: boolean): { inline_keyboard: Button[][] } {
  const ref = inboxId + ':' + id
  const row: Button[] = []
  if (unread && !archived) row.push({ text: '✅ Read', callback_data: 'r:' + ref })
  if (!archived) row.push({ text: '🗄 Archive', callback_data: 'a:' + ref })
  row.push({ text: '📄 Full text', callback_data: 'f:' + ref })
  return {
    inline_keyboard: [row, [
      { text: '🔇 Mute sender', callback_data: 'm:' + ref },
      { text: '↗️ Gmail', url: link },
    ]],
  }
}

// --------------------------------------------------------------- replies --

/** RFC 2047 for non-ASCII header text. */
export function encodeWord(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s
  return '=?UTF-8?B?' + bytesToBase64(new TextEncoder().encode(s)) + '?='
}

/** A Gmail API `raw` reply that threads under `email`, sent from `self`. */
export function buildReply(email: Email, self: string, text: string, all: boolean): { raw: string; to: string[]; cc: string[] } {
  const replyTo = parseAddressList(email.replyTo)
  const to = (replyTo.length ? replyTo : [email.from]).map((a) => a.email).filter((a) => a !== self)
  if (!to.length) to.push(email.from.email)
  const cc = all
    ? parseAddressList(email.to + ',' + email.cc).map((a) => a.email)
      .filter((a, i, list) => a !== self && !to.includes(a) && list.indexOf(a) === i)
    : []
  const subject = /^\s*re\s*:/i.test(email.subject) ? email.subject : 'Re: ' + email.subject
  const refs = [email.references, email.messageId].filter(Boolean).join(' ').trim()
  const headers = [
    'From: ' + self,
    'To: ' + to.join(', '),
    ...(cc.length ? ['Cc: ' + cc.join(', ')] : []),
    'Subject: ' + encodeWord(subject),
    ...(email.messageId ? ['In-Reply-To: ' + email.messageId] : []),
    ...(refs ? ['References: ' + refs] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ]
  const body = bytesToBase64(new TextEncoder().encode(text)).replace(/.{76}/g, '$&\r\n')
  const message = headers.join('\r\n') + '\r\n\r\n' + body
  return { raw: bytesToBase64url(new TextEncoder().encode(message)), to, cc }
}
