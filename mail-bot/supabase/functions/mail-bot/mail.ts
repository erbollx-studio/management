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
  snippet?: string
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
  snippet: string
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

// ------------------------------------------------------------------ mutes --

/** Free mail providers: muting "everyone at gmail.com" would mute half the world. */
const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'yahoo.co.uk', 'yahoo.ca',
  'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'comcast.net', 'verizon.net', 'cox.net', 'charter.net',
  'earthlink.net', 'proton.me', 'protonmail.com', 'zoho.com', 'mail.com', 'gmx.com', 'gmx.de', 'web.de',
  'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'yandex.ru', 'yandex.com', 'ya.ru', 'rambler.ru',
])

/** The sender's company domain, or null for free mail providers. */
export function companyDomain(email: string): string | null {
  const domain = email.split('@')[1] ?? ''
  return domain && !PUBLIC_DOMAINS.has(domain) ? domain : null
}

/**
 * A subject with the parts that change from email to email taken out, so
 * "Re: Your link | 2026-10-15 21:27" and "Your link | 2026-10-14 10:46" match.
 */
export function subjectKey(subject: string): string {
  return subject.toLowerCase()
    .replace(/^(\s*(re|fw|fwd|aw|ответ|пересл)\s*:\s*)+/i, '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/**
 * Mute entries come in three kinds: "name@company.com" (one sender),
 * "company.com" (everyone there) and "name@company.com :: subject key"
 * (that sender's emails like one they sent before).
 */
export function isMuted(muted: string[], email: string, subject = ''): boolean {
  return muted.some((m) => {
    if (m === email) return true
    const cut = m.indexOf(' :: ')
    if (cut >= 0) return email === m.slice(0, cut) && subjectKey(subject) === m.slice(cut + 4)
    return !m.includes('@') && (email.endsWith('@' + m) || email.endsWith('.' + m))
  })
}

/** The mute entry for a 🔕 choice: s = this sender, d = their company, t = emails like this one. */
export function muteEntry(email: Email, kind: string): string | null {
  const sender = email.from.email
  if (!sender) return null
  if (kind === 's') return sender
  if (kind === 'd') return companyDomain(sender)
  if (kind === 't') return sender + ' :: ' + subjectKey(email.subject)
  return null
}

/** A mute entry in words, for /muted and the 🔕 confirmation. */
export function describeMute(entry: string): string {
  const cut = entry.indexOf(' :: ')
  if (cut >= 0) return 'emails like "' + entry.slice(cut + 4) + '" from ' + entry.slice(0, cut)
  return entry.includes('@') ? entry : 'everyone at ' + entry
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
    snippet: decodeEntities(msg.snippet ?? ''),
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
    .replace(/[^\S\n]+\n/g, '\n') // trailing spaces, tabs and non-breaking spaces
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

// --------------------------------------------------------------- filters --

/**
 * Words that mean the same thing for filtering, in English and Russian. A rule
 * word from a family matches the whole family, so "payment" also finds
 * "invoice" and "оплата". A member ending in * matches any word starting with
 * it; the rest match only as whole words, so "ach" never matches "achieve" and
 * "tax" never matches "taxi". Phrases stand in for words too common alone:
 * "privacy policy" is in every footer and "claim" in every ad.
 */
export const FAMILIES: string[][] = [
  ['payment*', 'pay', 'paid', 'invoice*', 'receipt*', 'remittance*', 'settlement*', 'ach', 'wire transfer*', 'payout*',
    'refund*', 'billing', 'balance due', 'amount due', 'оплат*', 'платеж*', 'счет', 'счета', 'инвойс*', 'квитанц*'],
  ['insur*', 'coi', 'certificate of insurance', 'policy number', 'policy renewal', 'premium*', 'coverage',
    'underwrit*', 'endorsement*', 'claim number', 'страхов*', 'полис*'],
  ['audit*', 'compliance', 'ifta', 'fmcsa', 'inspection*', 'аудит*', 'проверк*', 'ревизи*'],
  ['contract*', 'agreement*', 'docusign', 'hellosign', 'dropbox sign', 'signature request*', 'please sign', 'nda',
    'договор*', 'соглашени*', 'подпис*'],
  ['tax', 'taxes', 'taxation', 'irs', '1099*', 'w-9', 'w9', 'налог*', 'декларац*'],
]

/** Lower case, ё → е, so "Счёт" and "счет" are the same word. */
function fold(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е')
}

/** The family a rule word belongs to ("payment", "оплата", "insurance"), if any. */
export function familyOf(word: string): string[] | null {
  const w = fold(word.replace(/\*$/, '').trim())
  return FAMILIES.find((family) =>
    family.some((m) => (m.endsWith('*') ? w.startsWith(fold(m.slice(0, -1))) : w === fold(m)))
  ) ?? null
}

/** The other words a rule word also matches, for showing the user. */
export function similarWords(word: string): string[] {
  const w = fold(word.trim())
  return (familyOf(word) ?? []).map((m) => m.replace(/\*$/, '')).filter((m) => fold(m) !== w)
}

/**
 * The text in `text` that `word` matches, or ''. A trailing * means "any word
 * starting with this"; without it only the whole word counts. Spaces inside
 * `word` match any run of spaces, so "late payment" finds "late  payment".
 */
export function findWord(text: string, word: string): string {
  const prefix = word.endsWith('*')
  const w = fold(prefix ? word.slice(0, -1) : word).trim()
  if (!w) return ''
  const body = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const re = new RegExp('(?<![\\p{L}\\p{N}])' + body + (prefix ? '[\\p{L}\\p{N}]*' : '(?![\\p{L}\\p{N}])'), 'u')
  return re.exec(fold(text))?.[0] ?? ''
}

/** A rule word found in `text`: its family if it has one, otherwise any word starting with it. */
function findRuleWord(text: string, word: string): string {
  const family = familyOf(word)
  for (const w of family ?? [word.endsWith('*') ? word : word + '*']) {
    const hit = findWord(text, w)
    if (hit) return hit
  }
  return ''
}

/**
 * Filter rules from what the user typed: commas (or new lines) separate rules,
 * and + joins words that must all be in the email.
 *   "payment, erbol"          → either word
 *   "insurance + payment"     → both words
 */
export function parseRules(input: string): string[] {
  const rules = input.split(/[,;\n]+/).map((rule) =>
    rule.split('+').map((w) => w.trim().replace(/\s+/g, ' ').toLowerCase()).filter(Boolean).join(' + ')
  )
  return [...new Set(rules.filter(Boolean))]
}

/**
 * Whether an email passes an inbox's rules, and the words that let it through
 * (as found in the email, e.g. "invoice + premium" for "payment + insurance").
 * No rules means everything passes. The whole email is searched: subject,
 * sender, full text and attachment names; without a body (list views) the
 * snippet stands in.
 */
export function matchRules(email: Email, rules: string[]): { pass: boolean; tags: string[] } {
  if (!rules.length) return { pass: true, tags: [] }
  const text = [email.subject, email.from.name, email.from.email,
    email.text ? readableBody(email, false) : email.snippet, ...email.attachments.map((a) => a.name)].join('\n')
  const tags: string[] = []
  for (const rule of rules) {
    const found = rule.split(' + ').map((w) => findRuleWord(text, w))
    if (found.every(Boolean)) tags.push(found.join(' + '))
  }
  return { pass: tags.length > 0, tags }
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

/**
 * An email card. Without `body` it is the minimal one-liner "Sender → inbox";
 * with it, the subject, time, matched filter words and the text follow. The
 * sender links to the email in Gmail, and the reply flow reads that link back.
 */
export function cardText(
  o: { inbox: string; email: Email; link: string; timeZone: string; tags?: string[]; body?: string },
): string {
  const { email } = o
  const head = '<a href="' + esc(o.link) + '"><b>' + esc(clip(email.from.label, 80)) + '</b></a> → ' + esc(o.inbox)
  if (o.body === undefined) return head
  const lines = [
    head,
    '<b>' + esc(clip(email.subject || '(no subject)', 300)) + '</b>',
    fmtDate(email.date, o.timeZone) + (o.tags?.length ? ' · 🏷 ' + esc(clip(o.tags.join(', '), 200)) : ''),
  ]
  if (o.body) lines.push('', esc(o.body))
  return lines.join('\n')
}

export interface Button {
  text: string
  callback_data?: string
  url?: string
}

/** Buttons for a card: "min" is the one-liner, "more" shows the preview, "full" the whole text. */
export function emailKeyboard(
  inboxId: number,
  id: string,
  link: string,
  view: 'min' | 'more' | 'full',
  files = 0,
): { inline_keyboard: Button[][] } {
  const ref = inboxId + ':' + id
  const done: Button[] = [
    { text: '🗑 Delete', callback_data: 'd:' + ref },
    { text: '🔕 Stop', callback_data: 's:' + ref },
  ]
  if (view === 'min') return { inline_keyboard: [[{ text: '▾ More', callback_data: 'v:' + ref }, ...done]] }
  const top: Button[] = [{ text: '▴ Less', callback_data: 'c:' + ref }]
  if (view === 'more') top.push({ text: '📄 Full text', callback_data: 'f:' + ref })
  if (files) top.push({ text: '📎 ' + files, callback_data: 'p:' + ref })
  top.push({ text: '↗ Gmail', url: link })
  return { inline_keyboard: [top, [{ text: '🗄 Archive', callback_data: 'a:' + ref }, ...done]] }
}

/** The 🔕 choices for one email. The company choice is left out for free mail providers. */
export function stopKeyboard(inboxId: number, email: Email): { inline_keyboard: Button[][] } {
  const ref = inboxId + ':' + email.id
  const company = companyDomain(email.from.email)
  return {
    inline_keyboard: [
      [{ text: '🔕 This sender: ' + clip(email.from.email, 40), callback_data: 'M:' + ref + ':s' }],
      ...(company ? [[{ text: '🔕 Everyone at ' + company, callback_data: 'M:' + ref + ':d' }]] : []),
      [{ text: '🔕 Emails like this one', callback_data: 'M:' + ref + ':t' }],
      [{ text: '‹ Back', callback_data: 'c:' + ref }],
    ],
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
