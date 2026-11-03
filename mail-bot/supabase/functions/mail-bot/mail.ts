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

/** Whether an address is `entry`: the same address, or anyone at `entry` when it is a domain. */
function matchesEntry(entry: string, email: string): boolean {
  if (entry === email) return true
  return !entry.includes('@') && (email.endsWith('@' + entry) || email.endsWith('.' + entry))
}

/**
 * Mute entries come in three kinds: "name@company.com" (one sender),
 * "company.com" (everyone there) and "name@company.com :: subject key"
 * (that sender's emails like one they sent before).
 */
export function isMuted(muted: string[], email: string, subject = ''): boolean {
  return muted.some((m) => {
    const cut = m.indexOf(' :: ')
    if (cut >= 0) return email === m.slice(0, cut) && subjectKey(subject) === m.slice(cut + 4)
    return matchesEntry(m, email)
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

interface HistoryMessage {
  id: string
  threadId?: string
  labelIds?: string[]
}

export interface HistoryRecord {
  messagesAdded?: { message: HistoryMessage }[]
  labelsAdded?: { message: HistoryMessage; labelIds?: string[] }[]
}

/**
 * The emails that got the label `tagId` in these Gmail history records: put on
 * by hand (labelsAdded) or there when the email arrived, e.g. by a Gmail
 * filter (messagesAdded). Tagging a conversation in Gmail tags every message
 * in it, so each conversation gives only its newest message (Gmail ids grow
 * with time).
 */
export function taggedIds(records: HistoryRecord[], tagId: string): string[] {
  const newest = new Map<string, string>()
  for (const h of records) {
    const hits = [
      ...(h.messagesAdded ?? []).filter((a) => a.message.labelIds?.includes(tagId)),
      ...(h.labelsAdded ?? []).filter((a) => a.labelIds?.includes(tagId)),
    ]
    for (const { message: m } of hits) {
      const thread = m.threadId ?? m.id
      const seen = newest.get(thread)
      // Hex ids: longer is newer, and at equal length the text order is the number order.
      if (!seen || m.id.length > seen.length || (m.id.length === seen.length && m.id > seen)) newest.set(thread, m.id)
    }
  }
  return [...newest.values()]
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
  // Word edges only where the word itself starts or ends with a letter, so "policy #" finds "policy #A-4411".
  const head = /^[\p{L}\p{N}]/u.test(w) ? '(?<![\\p{L}\\p{N}])' : ''
  const tail = prefix ? '[\\p{L}\\p{N}]*' : /[\p{L}\p{N}]$/u.test(w) ? '(?![\\p{L}\\p{N}])' : ''
  return new RegExp(head + body + tail, 'u').exec(fold(text))?.[0] ?? ''
}

/** The first of `words` found in `text`, as written there, or ''. */
function firstWord(text: string, words: string[]): string {
  for (const w of words) {
    const hit = findWord(text, w)
    if (hit) return hit
  }
  return ''
}

/** A rule word found in `text`: its family if it has one, otherwise any word starting with it. */
function findRuleWord(text: string, word: string): string {
  return firstWord(text, familyOf(word) ?? [word.endsWith('*') ? word : word + '*'])
}

/** Where a signature starts: a line that is "--", "Thanks," / "Thanks, Grace", "Best regards" or "Sent from my iPhone". */
const SIGNATURE =
  /^[ \t]*(--[ \t]*$|(thanks|thank you|thx|regards|best|best regards|kind regards|warm regards|sincerely|cheers|respectfully|спасибо|с уважением)[ \t]*(,[^\n]{0,30}|[.!]*)[ \t]*$|sent from my )/im

/** An address, a link or a phone number: on a short line, that line is a signature or footer line. */
const CONTACT = /\S@\S+\.\w|https?:\/\/|www\.|\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/i

/**
 * The first lines of the newest message: old replies, the signature and
 * everything after it are cut off, short contact lines ("INVOICES / BILLING:
 * ap@broker.com", "view your pending payments at https://…") are skipped,
 * then the first `n` characters are kept. Broker signatures ("Need
 * factoring?"), footers and load terms ("you will forfeit payment") sit
 * there, so they don't decide anything.
 */
export function opening(email: Email, n = 300): string {
  if (!email.text) return email.snippet.slice(0, n)
  const body = readableBody(email, true)
  // A "Thanks!" as the very first line is the message, not the signature.
  const sig = body.slice(40).search(SIGNATURE)
  return (sig >= 0 ? body.slice(0, 40 + sig) : body).split('\n')
    .filter((line) => line.length >= 100 || !CONTACT.test(line)).join('\n').slice(0, n)
}

/** What templates and word filters search: subject, sender, file names and the first lines of the newest message. */
function searchText(email: Email): string {
  return [email.subject, email.from.name, email.from.email, ...email.attachments.map((a) => a.name), opening(email)]
    .join('\n')
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
 * No rules means everything passes. The subject, sender, file names and the
 * first lines of the newest message are searched; without a body (list views)
 * the snippet stands in.
 */
export function matchRules(email: Email, rules: string[]): { pass: boolean; tags: string[] } {
  if (!rules.length) return { pass: true, tags: [] }
  const text = searchText(email)
  const tags: string[] = []
  for (const rule of rules) {
    const found = rule.split(' + ').map((w) => findRuleWord(text, w))
    if (found.every(Boolean)) tags.push(found.join(' + '))
  }
  return { pass: tags.length > 0, tags }
}

// ------------------------------------------------------------- templates --

/**
 * The words behind the templates, written as for findWord. Words that broker
 * load offers and rate confirmations use for other things are left out or
 * kept only as phrases: "paid" ("truck will be paid per mile"), "billing",
 * "factoring", "balance", "coverage" ("cargo coverage $100k") and "policy"
 * ("pick-up number policy"). "bill" alone is also a name, and "Premium plan"
 * ads would read as insurance.
 */
export const MONEY_WORDS = [
  'payment*', 'invoice*', 'receipt*', 'remittance*', 'settlement*', 'statement*', 'ach', 'wire transfer*', 'wired',
  'amount due', 'amount paid', 'balance due', 'outstanding balance', 'paid in full', 'past due', 'premium due',
  'оплат*', 'платеж*', 'счет', 'счета', 'инвойс*', 'квитанц*',
]
export const INSURANCE_WORDS = [
  'insur*', 'policy #', 'policy no', 'policy number', 'policy period', 'policy renewal', 'your policy',
  'policyholder*', 'coi', 'certificate of insurance', 'certificate holder', 'endorsement*', 'underwrit*',
  'premium due', 'premium notice', 'premium payment', 'annual premium', 'monthly premium', 'premiums',
  'страхов*', 'полис*',
]
export const URGENT_WORDS = [
  'past due', 'overdue', 'final notice', 'cancellation', 'cancelled', 'canceled', 'non-payment', 'nonpayment',
  'non payment', 'lapse*', 'просроч*', 'отмен*', 'расторж*',
]

/** Footer phrases that would make every newsletter look like insurance or money mail. */
const FOOTER_PHRASES =
  /\b(privacy|cookies?|returns?|refund|shipping|delivery|data|usage|acceptable use|security|company|travel)\s+(policy|policies|statement|notice)\b|\bcancellation\s+polic(y|ies)\b/gi

/** Someone whose emails always come through: one address, or a domain for everyone there. */
export interface Person {
  entry: string
  name: string
  note: string
}

export function personFor(people: Person[], email: string): Person | null {
  return people.find((p) => p.entry === email) ?? people.find((p) => matchesEntry(p.entry, email)) ?? null
}

export interface Verdict {
  /** The template, or "words" for the inbox's own words, or "none". */
  kind: 'urgent' | 'insurance' | 'money' | 'person' | 'words' | 'none'
  /** The card's top line; '' for none. */
  label: string
  /** The words in the email that chose the template, for ▾ More. */
  tags: string[]
}

/**
 * Sorts an email into a template, first match wins: 🔴 insurance that is past
 * due or being cancelled (money words or not), 💰 insurance + money, 🧾 money,
 * ⭐ one of your people. Otherwise the inbox's own `rules` decide, then none.
 * Your people are named on any template's card.
 */
export function classify(email: Email, people: Person[], rules: string[]): Verdict {
  const text = searchText(email).replace(FOOTER_PHRASES, ' ')
  const insurance = firstWord(text, INSURANCE_WORDS)
  const money = firstWord(text, MONEY_WORDS)
  const urgent = insurance ? firstWord(text, URGENT_WORDS) : ''
  const person = personFor(people, email.from.email)
  const star = person ? '⭐ ' + (person.name || email.from.label) : ''
  let v: Verdict
  if (urgent) {
    v = { kind: 'urgent', label: '🔴 Insurance' + (money ? ' payment' : '') + ' · URGENT',
      tags: [...new Set([insurance, urgent, money].filter(Boolean))] }
  } else if (insurance && money) {
    v = { kind: 'insurance', label: '💰 Insurance payment', tags: [money === insurance ? money : money + ' + ' + insurance] }
  } else if (money) {
    v = { kind: 'money', label: '🧾 Invoice / payment', tags: [money] }
  } else if (person) {
    return { kind: 'person', label: star + (person.note ? ' · ' + person.note : ''), tags: [] }
  } else {
    const own = rules.length ? matchRules(email, rules).tags : []
    v = own.length ? { kind: 'words', label: '🏷 ' + own.join(', '), tags: own } : { kind: 'none', label: '', tags: [] }
  }
  if (star && v.kind !== 'none') v.label += ' · ' + star
  return v
}

// -------------------------------------------------------------- deciding --

/** US states and Canadian provinces; AR and OK are left out, they are everyday words in subjects too. */
const REGIONS = 'AL|AK|AZ|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|' +
  'ND|OH|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|AB|BC|MB|NB|NL|NS|ON|PE|QC|SK'

/**
 * Subjects of load emails: load and PO numbers, rate confirmations, tenders,
 * delivery papers, pickups, and lanes like "Las Vegas, NV to Rocklin, CA",
 * "CA >> KANSAS CITY MO" or "CA-NV". The lane check wants capital state codes.
 */
const LOAD_SUBJECTS = [
  /\bloads?\s*(#\s*\w*|no\.?\s*\d\w*|number\b\s*\w*|id\b|\d\w*)/i,
  /\bp\.?o\.?\s*#?\s*\d\w*/i,
  /\brate\s*con/i,
  /\b(delivery|lumper)\s+receipt/i,
  /\bproof of delivery\b|\bpods?\b|\bbol\b|\bb\/l\b|\bbill of lading\b/i,
  /\btender/i,
  /\bpick[\s-]?up\b/i,
  /\bPU\b/,
  /\bscale ticket|\btonu\b|\bdetention\b|\blumper\b/i,
  new RegExp('\\b(' + REGIONS + ')\\b\\s*(to|TO|To|→|>>|->|–|—|-)\\s*([A-Za-z .\'-]{0,30},?\\s*)?\\b(' + REGIONS + ')\\b'),
]

/** The load words in a subject ("Load #8646459", "Rate Confirmation", "NV to Rocklin, CA"), or ''. */
export function loadMark(subject: string): string {
  for (const re of LOAD_SUBJECTS) {
    const m = re.exec(subject)
    if (m) return m[0].trim()
  }
  return ''
}

/** A sender's entry on the money list: their company domain, or the address for free mail. */
export function senderEntry(email: string): string {
  return companyDomain(email) ?? email
}

/** A sender's answer on the money list: by address, then by domain and the domains above it. */
export function senderStatus(senders: Record<string, string>, email: string): string | undefined {
  if (senders[email]) return senders[email]
  let domain = email.split('@')[1] ?? ''
  while (domain.includes('.')) {
    if (senders[domain]) return senders[domain]
    domain = domain.slice(domain.indexOf('.') + 1)
  }
  return undefined
}

export interface Decision extends Verdict {
  /** chat: post it. ask: post it once, with ✓ Allow / ✕ Not money. list: the daily list. */
  send: 'chat' | 'ask' | 'list'
  /** The money-list entry for this sender ("ecapital.com"). */
  sender: string
  /** A money email from a sender with no answer yet: its card carries ✓ Allow / ✕ Not money. */
  asking: boolean
  /** The load words that keep it out, or ''. */
  load: string
}

/**
 * Where an email goes. 🔴 urgent insurance and ⭐ your people always come.
 * Load emails never do, even when they say "payment". 💰 and 🧾 money emails
 * come only from senders on the money list (`senders`: entry → allowed,
 * asked or denied); a sender with no entry is asked about once, after that
 * their money emails wait for the answer in the daily list. The inbox's own
 * words come too, unless it's a load email. Everything else: the daily list.
 */
export function decide(email: Email, people: Person[], rules: string[], senders: Record<string, string>): Decision {
  const v = classify(email, people, rules)
  const base = { ...v, sender: senderEntry(email.from.email), load: loadMark(email.subject), asking: false }
  if (v.kind === 'urgent' || personFor(people, email.from.email)) return { ...base, send: 'chat' }
  if (v.kind === 'none' || base.load) return { ...base, send: 'list' }
  if (v.kind === 'money' || v.kind === 'insurance') {
    const status = senderStatus(senders, email.from.email)
    if (status === 'allowed') return { ...base, send: 'chat' }
    if (status === 'denied') return { ...base, send: 'list' }
    return { ...base, send: status === 'asked' ? 'list' : 'ask', asking: true }
  }
  return { ...base, send: 'chat' }
}

// ------------------------------------------------------------------ time --

/** The wall clock in `tz` at `d`: year, month (1-12), day, hour (0-23), minute. */
export function localParts(d: Date, tz: string): { y: number; m: number; d: number; h: number; min: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(d).map((p) => [p.type, p.value]),
  )
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour, min: +parts.minute }
}

/** The moment the clock in `tz` shows y-m-d h:min. Days past the month's end roll over. */
export function atLocal(tz: string, y: number, m: number, d: number, h = 0, min = 0): Date {
  const guess = Date.UTC(y, m - 1, d, h, min)
  const p = localParts(new Date(guess), tz)
  return new Date(guess - (Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - guess))
}

/** Quiet hours from what was typed: "22-7" → 22:00 to 7:00; "off" or nonsense → none. */
export function parseQuiet(s: string): { from: number; to: number } | null {
  const m = /^\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s*$/.exec(s)
  if (!m || +m[1] > 23 || +m[2] > 23 || +m[1] === +m[2]) return null
  return { from: +m[1], to: +m[2] }
}

/** Whether `now` is inside the quiet hours in `tz`; 22-7 runs past midnight. */
export function isQuiet(now: Date, tz: string, quiet: { from: number; to: number } | null): boolean {
  if (!quiet) return false
  const h = localParts(now, tz).h
  return quiet.from > quiet.to ? h >= quiet.from || h < quiet.to : h >= quiet.from && h < quiet.to
}

/** When a ⏰ card comes back: h = in an hour, e = tonight at 19:00, m = tomorrow at 9:00. */
export function laterTime(choice: string, now: Date, tz: string): Date {
  const t = localParts(now, tz)
  if (choice === 'e') return atLocal(tz, t.y, t.m, t.d, 19)
  if (choice === 'm') return atLocal(tz, t.y, t.m, t.d + 1, 9)
  return new Date(now.getTime() + 60 * 60_000)
}

/** "today at 19:00", "tomorrow at 9:00", or the date, for telling when something comes back. */
export function fmtWhen(due: Date, now: Date, tz: string): string {
  const d = localParts(due, tz)
  const t = localParts(now, tz)
  const tomorrow = localParts(atLocal(tz, t.y, t.m, t.d + 1, 12), tz)
  const at = d.h + ':' + String(d.min).padStart(2, '0')
  if (d.y === t.y && d.m === t.m && d.d === t.d) return 'today at ' + at
  if (d.y === tomorrow.y && d.m === tomorrow.m && d.d === tomorrow.d) return 'tomorrow at ' + at
  return fmtDate(due, tz)
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

/** The start of an email as one short paragraph, for the card that arrives. */
export function preview(email: Email, n: number): string {
  return clip((readableBody(email, true) || email.snippet).replace(/\s+/g, ' ').trim(), n)
}

/** The inbox's name: the one Gmail has for it, else how this email addressed it. */
export function inboxName(label: string | null, inbox: string, email: Email): string {
  return label || parseAddressList(email.to + ',' + email.cc).find((a) => a.email === inbox)?.name || ''
}

/** "Name · address", or just the address when there is no name. */
function who(name: string, email: string): string {
  return name && name.toLowerCase() !== email ? esc(clip(name, 60)) + ' · ' + esc(email) : esc(email)
}

/**
 * An email card: the template line, From and To with names, the subject, then
 * `body`. With `details` (▾ More) the time and the words that chose the
 * template come before the text. The subject links to the email in Gmail,
 * and the reply flow reads that link back.
 */
export function cardText(o: {
  label: string
  email: Email
  inbox: { email: string; name: string }
  link: string
  timeZone: string
  body: string
  details?: boolean
  tags?: string[]
}): string {
  const { email } = o
  const lines = [
    ...(o.label ? ['<b>' + esc(o.label) + '</b>'] : []),
    '<b>From:</b> ' + who(email.from.name, email.from.email),
    '<b>To:</b> ' + who(o.inbox.name, o.inbox.email),
    '<b>Subject:</b> <a href="' + esc(o.link) + '">' + esc(clip(email.subject || '(no subject)', 300)) + '</a>',
  ]
  if (o.details) {
    lines.push('🕐 ' + fmtDate(email.date, o.timeZone) + (o.tags?.length ? ' · 🏷 ' + esc(clip(o.tags.join(', '), 200)) : ''))
    if (o.body) lines.push('')
  }
  if (o.body) lines.push(esc(o.body))
  return lines.join('\n')
}

export interface Button {
  text: string
  callback_data?: string
  url?: string
}

/**
 * Buttons for a card: "min" is the card that arrives, "more" shows the
 * preview, "full" the whole text. `ask` (a money-list entry) puts ✓ Allow /
 * ✕ Not money on top, for a money email from a sender with no answer yet.
 */
export function emailKeyboard(
  inboxId: number,
  id: string,
  link: string,
  view: 'min' | 'more' | 'full',
  files = 0,
  ask = '',
): { inline_keyboard: Button[][] } {
  const ref = inboxId + ':' + id
  const asking: Button[][] = ask
    ? [[{ text: '✓ Allow ' + clip(ask, 28), callback_data: 'G:' + ref }, { text: '✕ Not money', callback_data: 'B:' + ref }]]
    : []
  const reply: Button = { text: '↩ Reply', callback_data: 'R:' + ref }
  const later: Button = { text: '⏰', callback_data: 'T:' + ref }
  const done: Button[] = [
    { text: '🗑', callback_data: 'd:' + ref },
    { text: '🔕', callback_data: 's:' + ref },
  ]
  if (view === 'min') {
    return { inline_keyboard: [...asking, [{ text: '▾ More', callback_data: 'v:' + ref }, reply, later, ...done]] }
  }
  const top: Button[] = [{ text: '▴ Less', callback_data: 'c:' + ref }]
  if (view === 'more') top.push({ text: '📄 Full text', callback_data: 'f:' + ref })
  if (files) top.push({ text: '📎 ' + files, callback_data: 'p:' + ref })
  top.push({ text: '↗ Gmail', url: link })
  return { inline_keyboard: [...asking, top, [reply, later, { text: '🗄 Archive', callback_data: 'a:' + ref }, ...done]] }
}

/** The ⏰ choices for a card. "Tonight" is offered only before 18:00. */
export function laterKeyboard(inboxId: number, id: string, now: Date, tz: string): { inline_keyboard: Button[][] } {
  const ref = inboxId + ':' + id
  return {
    inline_keyboard: [
      [{ text: '⏰ In 1 hour', callback_data: 'W:' + ref + ':h' }],
      ...(localParts(now, tz).h < 18 ? [[{ text: '🌙 Tonight 19:00', callback_data: 'W:' + ref + ':e' }]] : []),
      [{ text: '☀️ Tomorrow 9:00', callback_data: 'W:' + ref + ':m' }],
      [{ text: '‹ Back', callback_data: 'c:' + ref }],
    ],
  }
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
