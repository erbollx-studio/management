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
  /\bpro\s*(#|no\.?|number)\s*\(?\d/i,
  new RegExp('\\b(' + REGIONS + ')\\b\\s*(to|TO|To|→|>>|->|>|–|—|-)\\s*([A-Za-z .\'-]{0,30},?\\s*)?\\b(' + REGIONS + ')\\b'),
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

// ---------------------------------------------------- learned not-money types --

/**
 * ✕ Not money also learns the type of email, kept on the money list as
 * "subject:" + its typeKey with status denied. No address or domain has a ":",
 * so these never mix with senders.
 */
export const TYPE_PREFIX = 'subject:'

/** Month and weekday names, so "Report for Oct 30" and "Report for Nov 6" are the same type. */
const DATE_NAMES = new RegExp('\\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|' +
  'sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|monday|tuesday|wednesday|thursday|friday|' +
  'saturday|sunday|(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)(?=,))\\b\\.?', 'gi')

/**
 * A subject as a type of email: subjectKey (no numbers, dates, Re: or Fwd:)
 * with month and weekday names and am/pm also taken out. A separate function,
 * so the 🔕 mutes you already have keep matching.
 */
export function typeKey(subject: string): string {
  return subjectKey(subject.replace(/(\d)\s*[ap]\.?m\.?(?![a-z])/gi, '$1').replace(DATE_NAMES, '0'))
}

/**
 * Words that don't tell one kind of email from another: real invoices and
 * payment notices from anyone are full of them. They don't count toward a
 * learned type, and neither do the money, insurance and urgent words.
 */
const PLAIN_WORDS = new Set([
  'the', 'and', 'for', 'from', 'with', 'your', 'you', 'our', 'its', 'has', 'have', 'had', 'been', 'are', 'was',
  'were', 'will', 'can', 'this', 'that', 'here', 'there', 'now', 'new', 'just', 'all', 'any', 'not', 'off', 'out',
  'per', 'via', 'about', 'into', 'get', 'got', 'see', 'view', 'please', 'pls', 'thank', 'thanks', 'dear', 'hello',
  'regarding', 'attn', 'fyi', 'inc', 'llc', 'ltd', 'corp', 'company', 'team', 'dept', 'office', 'com', 'net', 'org',
  'www', 'info', 'information', 'important', 'action', 'required', 'urgent', 'update', 'updated', 'reminder',
  'notice', 'notification', 'alert', 'confirmation', 'confirmed', 'confirm', 'request', 'requested', 'ready',
  'available', 'attached', 'attachment', 'copy', 'document', 'documents', 'docs', 'pdf', 'file', 'files',
  'generated', 'change', 'changed', 'address', 'invoice', 'inv', 'bill', 'bills', 'billing', 'due', 'amount',
  'balance', 'total', 'paid', 'pay', 'unpaid', 'outstanding', 'overdue', 'past', 'received', 'receive', 'sent',
  'send', 'processed', 'processing', 'scheduled', 'pending', 'approved', 'approval', 'declined', 'failed', 'status',
  'summary', 'report', 'reports', 'details', 'detail', 'advice', 'account', 'acct', 'customer', 'client', 'vendor',
  'carrier', 'number', 'ref', 'reference', 'period', 'date', 'check', 'cheque', 'deposit', 'direct', 'transfer',
  'wire', 'funds', 'fund', 'transaction', 'transactions', 'order', 'purchase', 'credit', 'debit', 'card', 'bank',
  'online', 'auto', 'autopay', 'final', 'open', 'closed', 'quote', 'today', 'weekly', 'monthly', 'daily', 'annual',
  'yearly', 'quarterly', 'week', 'month', 'year', 'full', 'partial', 'fee', 'fees', 'charge', 'charges', 'cost',
  'rate', 'price', 'tax', 'taxes', 'owed', 'money', 'cash', 'load', 'loads', 'policy', 'policies', 'renewal',
  'certificate', 'holder', 'history', 'submission', 'submitted', 'made', 'completed', 'complete', 'successful',
  'non', 'city', 'state', 'county', 'ваш', 'ваша', 'ваше', 'для', 'новый', 'новая', 'напоминание', 'уведомление',
  'отчет', 'документ', 'документы', 'акт', 'сверки', 'сумма', 'долг', 'задолженность', 'месяц', 'год',
])

/** Money, insurance and urgent words, the template lists and the filter families together. */
const MONEY_LIKE = [...MONEY_WORDS, ...INSURANCE_WORDS, ...URGENT_WORDS, ...FAMILIES[0], ...FAMILIES[1]]

/**
 * The type ✕ Not money learns from an email: its typeKey ("your weekly fuel
 * savings report ##"), for money emails from anyone. Only when the subject has
 * at least two words of its own besides money words and plain ones ("fuel",
 * "savings"): an exact subject like that is one sender's template. null for
 * "Invoice 4411", "Payment received", "Download your statement" or
 * "Remittance advice from eCapital": real money emails from others look just
 * like those, so learning them would hide real money.
 */
export function learnedType(subject: string): string | null {
  const key = typeKey(subject)
  const own = new Set(fold(key).split(/[^\p{L}]+/u).filter((w) =>
    w.length >= 3 && !PLAIN_WORDS.has(w) && !firstWord(w, MONEY_LIKE)
  ))
  return own.size >= 2 ? key : null
}

/** A money-list entry in words: the sender, or 'emails like "…"' for a learned type. */
export function describeSender(entry: string): string {
  return entry.startsWith(TYPE_PREFIX) ? 'emails like "' + entry.slice(TYPE_PREFIX.length) + '"' : entry
}

/**
 * The learned type this email is, or ''. The inbox's own /filter words beat
 * it: you asked for those emails by name.
 */
function learnedMatch(email: Email, rules: string[], senders: Record<string, string>): string {
  const key = typeKey(email.subject)
  if (!key || senders[TYPE_PREFIX + key] !== 'denied' || learnedType(email.subject) !== key) return ''
  return rules.length && matchRules(email, rules).pass ? '' : key
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
  /** The type you marked ✕ Not money that sent it to the daily list ("your weekly fuel savings report ##"), or ''. */
  learned: string
}

/**
 * Where an email goes. 🔴 urgent insurance and ⭐ your people always come.
 * Load emails never do, even when they say "payment". 💰 and 🧾 money emails
 * come only from senders on the money list (`senders`: entry → allowed,
 * asked or denied); a sender with no entry is asked about once, after that
 * their money emails wait for the answer in the daily list. A new sender's
 * money email of a type you marked ✕ Not money goes to the daily list without
 * asking; allowed senders and the inbox's own words beat the type. The
 * inbox's own words come too, unless it's a load email. Everything else: the
 * daily list.
 */
export function decide(email: Email, people: Person[], rules: string[], senders: Record<string, string>): Decision {
  const v = classify(email, people, rules)
  const sender = senderEntry(email.from.email)
  const base = { ...v, sender, load: loadMark(email.subject), asking: false, learned: '' }
  if (v.kind === 'urgent' || personFor(people, email.from.email)) return { ...base, send: 'chat' }
  if (v.kind === 'none' || base.load) return { ...base, send: 'list' }
  if (v.kind === 'money' || v.kind === 'insurance') {
    const status = senderStatus(senders, email.from.email)
    if (status === 'allowed') return { ...base, send: 'chat' }
    if (status === 'denied') return { ...base, send: 'list' }
    // Still asking: if this card ever shows (an inbox on "all emails"), ✓ Allow is there.
    const learned = status ? '' : learnedMatch(email, rules, senders)
    if (learned) return { ...base, send: 'list', asking: true, learned }
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

// -------------------------------------------------------------- deadlines --

/** A date without a time: year, month (1-12), day. */
export interface Day {
  y: number
  m: number
  d: number
}

const DAY_MS = 86_400_000
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?'

/** "Nov 10", "November 10th, 2026", "10 Nov", "11/10", "11/10/26", "2026-11-10". Numbers are US order: month first. */
const DATE = new RegExp([
  '\\b' + MONTH + '\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?',
  '\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MONTH + '(?:,?\\s+(\\d{4})\\b)?',
  '(?<![\\d/.-])(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?(?![\\d/])',
  '(?<![\\d-])(\\d{4})-(\\d{2})-(\\d{2})(?![\\d-])',
].join('|'), 'gi')

/** Words that make a date after them, in the same sentence, a deadline. "Due to" is not one. */
const DUE_WORDS = /\b(?:due(?!\s+to\b)|overdue|deadline|expir\w*|cancel\w*|renew\w*|laps\w*|terminat\w*)\b/i
/** Words that do only right before the date: "send it by 11/7". */
const DUE_RIGHT_BEFORE = /\b(?:by|before|until|till|no later than)[\s:]*(?:the\s+)?$/i

function dayOf(m: RegExpMatchArray, thisYear: number, today: number): Day | null {
  const month = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1
  let mon: number, d: number, y: string | undefined
  if (m[1]) [mon, d, y] = [month(m[1]), +m[2], m[3]]
  else if (m[5]) [mon, d, y] = [month(m[5]), +m[4], m[6]]
  else if (m[7]) [mon, d, y] = [+m[7], +m[8], m[9]]
  else [mon, d, y] = [+m[11], +m[12], m[10]]
  let year = y ? (y.length === 2 ? 2000 + +y : +y) : thisYear
  // No year: this year's, or next year's when this year's passed more than two months ago.
  if (!y && Date.UTC(year, mon - 1, d) < today - 60 * DAY_MS) year++
  const check = new Date(Date.UTC(year, mon - 1, d))
  if (mon < 1 || mon > 12 || check.getUTCMonth() !== mon - 1 || check.getUTCDate() !== d) return null
  return { y: year, m: mon, d }
}

/**
 * The soonest due date in an email: a date, today or within a year, after a
 * due word in the same sentence (due, deadline, expires, cancelled, renewal,
 * lapse…) or right after "by / before / until". Only the subject and the
 * newest message count, without old replies and the signature. Past dates
 * ("was due Oct 30") don't count.
 */
export function findDeadline(email: Email, now: Date, tz: string): Day | null {
  const text = email.subject + '\n' + opening(email, 1500)
  const t = localParts(now, tz)
  const today = Date.UTC(t.y, t.m - 1, t.d)
  let best: Day | null = null
  let bestTime = Infinity
  let prevEnd = 0
  for (const m of text.matchAll(DATE)) {
    const start = m.index!
    // What comes before the date, back to the last date, the line start or the sentence start.
    let before = text.slice(Math.max(prevEnd, start - 60), start)
    prevEnd = start + m[0].length
    const ends = [before.lastIndexOf('\n'), ...[...before.matchAll(/[.!?](?=\s)/g)].map((x) => x.index!)]
    before = before.slice(Math.max(...ends) + 1)
    if (!DUE_WORDS.test(before) && !DUE_RIGHT_BEFORE.test(before)) continue
    const day = dayOf(m, t.y, today)
    if (!day) continue
    const time = Date.UTC(day.y, day.m - 1, day.d)
    if (time < today || time > today + 366 * DAY_MS || time >= bestTime) continue
    best = day
    bestTime = time
  }
  return best
}

/** Days from today in `tz` to `day`: 0 today, 1 tomorrow. */
function daysUntil(day: Day, now: Date, tz: string): number {
  const t = localParts(now, tz)
  return Math.round((Date.UTC(day.y, day.m - 1, day.d) - Date.UTC(t.y, t.m - 1, t.d)) / DAY_MS)
}

/** "2026-11-10", kept with a deadline reminder. */
export function dayKey(day: Day): string {
  return day.y + '-' + String(day.m).padStart(2, '0') + '-' + String(day.d).padStart(2, '0')
}

/** The card line: "📅 Due Tue 10 Nov (in 7 days)". */
export function dueLine(day: Day, now: Date, tz: string): string {
  const n = daysUntil(day, now, tz)
  const when = n === 0 ? 'today' : n === 1 ? 'tomorrow' : n < 0 ? 'passed' : 'in ' + n + ' days'
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(Date.UTC(day.y, day.m - 1, day.d)))
  return '📅 Due ' + date.replace(',', '') + ' (' + when + ')'
}

/** When a deadline reminds you: 3 days before and on the day, at 9:00 in `tz`; only the times still ahead. */
export function deadlineTimes(day: Day, now: Date, tz: string): Date[] {
  return [atLocal(tz, day.y, day.m, day.d - 3, 9), atLocal(tz, day.y, day.m, day.d, 9)].filter((t) => t > now)
}

/** A Google Calendar "new event" link: an all-day event on the due day. */
export function calendarLink(day: Day, title: string, details: string): string {
  const start = Date.UTC(day.y, day.m - 1, day.d)
  const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '')
  return 'https://calendar.google.com/calendar/render?' + new URLSearchParams({
    action: 'TEMPLATE',
    text: 'Due: ' + title,
    dates: ymd(start) + '/' + ymd(start + DAY_MS),
    details,
  })
}

// -------------------------------------------------------- nobody answered --

/**
 * `hours` of working time after `start`: only 8:00-20:00 in `tz` count, every
 * day of the week. An email at 18:00 plus 4 hours is 10:00 the next morning.
 */
export function addWorkingHours(start: Date, hours: number, tz: string, from = 8, to = 20): Date {
  let left = hours * 3_600_000
  let t = start.getTime()
  for (let i = 0; i < 400 && left > 0; i++) {
    const p = localParts(new Date(t), tz)
    const open = atLocal(tz, p.y, p.m, p.d, from).getTime()
    const close = atLocal(tz, p.y, p.m, p.d, to).getTime()
    if (t >= close) {
      t = atLocal(tz, p.y, p.m, p.d + 1, from).getTime()
      continue
    }
    if (t < open) t = open
    const step = Math.min(left, close - t)
    t += step
    left -= step
  }
  return new Date(t)
}

/** noreply@, do-not-reply@, notifications@, mailer-daemon@…: nobody waits for an answer. */
export function isNoReply(address: string): boolean {
  return /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer-daemon|postmaster|bounces?)(?![a-z])/i
    .test(address.split('@')[0] ?? '')
}

/** Whether any email in a Gmail conversation (threads/{id}?format=minimal) has the label `labelId`. */
export function threadHasLabel(thread: { messages?: { labelIds?: string[] }[] }, labelId: string): boolean {
  return (thread.messages ?? []).some((m) => (m.labelIds ?? []).includes(labelId))
}

/**
 * What a reply's conversation (threads/{id}?format=minimal) tells: `tagged`,
 * an email in it has the tag label; `starred`, you starred an email in it in
 * Gmail. Gmail puts both only on the emails you marked, never on the replies
 * that come after, so the whole conversation is what counts.
 */
export function conversationOf(
  thread: { messages?: { labelIds?: string[] }[] },
  tagId: string | null,
): { tagged: boolean; starred: boolean } {
  return {
    tagged: Boolean(tagId) && threadHasLabel(thread, tagId!),
    starred: threadHasLabel(thread, 'STARRED'),
  }
}

/** Whether the conversation (a Gmail thread, format=minimal) has a sent message after `since` (ms). */
export function answeredAfter(thread: { messages?: { labelIds?: string[]; internalDate?: string }[] }, since: number): boolean {
  return (thread.messages ?? []).some((m) => (m.labelIds ?? []).includes('SENT') && Number(m.internalDate) > since)
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
  /** The 📅 line ("📅 Due Tue 10 Nov (in 7 days)"), right under the subject. */
  due?: string
}): string {
  const { email } = o
  const lines = [
    ...(o.label ? ['<b>' + esc(o.label) + '</b>'] : []),
    '<b>From:</b> ' + who(email.from.name, email.from.email),
    '<b>To:</b> ' + who(o.inbox.name, o.inbox.email),
    '<b>Subject:</b> <a href="' + esc(o.link) + '">' + esc(clip(email.subject || '(no subject)', 300)) + '</a>',
    ...(o.due ? [esc(o.due)] : []),
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
 * `deadline` adds 📅 Add to Calendar and ✕ Wrong date (✓ Done on a reminder).
 */
export function emailKeyboard(
  inboxId: number,
  id: string,
  link: string,
  view: 'min' | 'more' | 'full',
  files = 0,
  ask = '',
  deadline?: { url: string; done: boolean },
): { inline_keyboard: Button[][] } {
  const ref = inboxId + ':' + id
  const asking: Button[][] = ask
    ? [[{ text: '✓ Allow ' + clip(ask, 28), callback_data: 'G:' + ref }, { text: '✕ Not money', callback_data: 'B:' + ref }]]
    : []
  const due: Button[][] = deadline
    ? [[
      { text: '📅 Add to Calendar', url: deadline.url },
      { text: deadline.done ? '✓ Done' : '✕ Wrong date', callback_data: 'Z:' + ref },
    ]]
    : []
  const reply: Button = { text: '↩ Reply', callback_data: 'R:' + ref }
  const later: Button = { text: '⏰', callback_data: 'T:' + ref }
  const done: Button[] = [
    { text: '🗑', callback_data: 'd:' + ref },
    { text: '🔕', callback_data: 's:' + ref },
  ]
  if (view === 'min') {
    return { inline_keyboard: [...asking, ...due, [{ text: '▾ More', callback_data: 'v:' + ref }, reply, later, ...done]] }
  }
  const top: Button[] = [{ text: '▴ Less', callback_data: 'c:' + ref }]
  if (view === 'more') top.push({ text: '📄 Full text', callback_data: 'f:' + ref })
  if (files) top.push({ text: '📎 ' + files, callback_data: 'p:' + ref })
  top.push({ text: '↗ Gmail', url: link })
  return { inline_keyboard: [...asking, top, ...due, [reply, later, { text: '🗄 Archive', callback_data: 'a:' + ref }, ...done]] }
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

// ------------------------------------------------------------- new email --

/** A typed address that can go in a To line: something@domain.tld, nothing else. */
const EMAIL_ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i

/**
 * The addresses typed for a new email. Commas, semicolons, spaces or new
 * lines may sit between them, and "Anna Lee <anna@x.com>" works too. `bad`
 * holds what doesn't look like an address, so the bot can ask again instead
 * of sending to a typo.
 */
export function parseRecipients(input: string): { ok: string[]; bad: string[] } {
  const ok: string[] = []
  const bad: string[] = []
  for (const item of parseAddressList(input.replace(/[;\n]+/g, ','))) {
    const words = item.email.split(/\s+/).map((w) => w.replace(/^mailto:/, '').replace(/^[<(]+|[>).]+$/g, ''))
    // "Anna anna@x.com": a name typed before the address, without the < >.
    const withAt = words.filter((w) => w.includes('@'))
    for (const w of withAt.length ? withAt : words) {
      if (!EMAIL_ADDRESS.test(w)) bad.push(w)
      else if (!ok.includes(w)) ok.push(w)
    }
  }
  return { ok, bad }
}

/**
 * Header text with non-ASCII letters, as RFC 2047 words, one per folded line,
 * each short enough that "Subject: " and the word fit in 76 characters. One
 * long word breaks the rules, and some mail programs then show it raw.
 */
export function encodeHeader(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s
  const enc = new TextEncoder()
  const chunks: string[] = []
  let chunk = ''
  for (const ch of s) {
    // 39 bytes are 52 base64 letters, 64 with =?UTF-8?B? and ?=.
    if (chunk && enc.encode(chunk + ch).length > 39) {
      chunks.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) chunks.push(chunk)
  return chunks.map((c) => '=?UTF-8?B?' + bytesToBase64(enc.encode(c)) + '?=').join('\r\n ')
}

/** "Dan Cargo <info@x.com>": the name quoted or encoded when it needs it; just the address without a name. */
function formatAddress(name: string, email: string): string {
  const n = name.replace(/[\r\n]+/g, ' ').trim()
  if (!n) return email
  if (!/^[\x20-\x7e]*$/.test(n)) return encodeHeader(n) + ' <' + email + '>'
  if (/^[\w !#$%&'*+/=?^`{|}~-]+$/.test(n)) return n + ' <' + email + '>'
  return '"' + n.replace(/["\\]/g, '\\$&') + '" <' + email + '>'
}

/** Addresses for a To line, folded so no line gets too long. */
function foldAddresses(list: string[]): string {
  const lines = ['']
  for (const a of list) {
    const last = lines.length - 1
    if (lines[last] && lines[last].length + a.length > 70) {
      lines[last] += ','
      lines.push(a)
    } else lines[last] += (lines[last] ? ', ' : '') + a
  }
  return lines.join('\r\n ')
}

/**
 * A Gmail API `raw` new email (messages/send): plain text in UTF-8, from
 * `from` with its name. It carries its own Message-ID and Date, so the answers
 * to it thread under it in Gmail and in the other side's mail program.
 * `id` is a random string for the Message-ID; passed in so tests can fix it.
 */
export function buildNewEmail(o: {
  from: string
  name?: string
  to: string[]
  subject: string
  text: string
  date: Date
  id: string
}): string {
  const domain = o.from.split('@')[1] || 'mail.gmail.com'
  const headers = [
    'From: ' + formatAddress(o.name ?? '', o.from),
    'To: ' + foldAddresses(o.to),
    'Subject: ' + encodeHeader(o.subject.replace(/[\r\n]+/g, ' ').trim()),
    'Date: ' + o.date.toUTCString().replace(/GMT$/, '+0000'),
    'Message-ID: <' + o.id + '@' + domain + '>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ]
  // Mail text lines end in CRLF; Telegram gives plain \n.
  const text = o.text.replace(/\r?\n/g, '\r\n')
  const body = bytesToBase64(new TextEncoder().encode(text)).replace(/.{76}/g, '$&\r\n')
  return bytesToBase64url(new TextEncoder().encode(headers.join('\r\n') + '\r\n\r\n' + body))
}

// ---------------------------------------------------------------- polish --

/**
 * What the AI is told. The rules about numbers and names matter most: a
 * changed amount or load number in an email to a broker costs real money, and
 * numbersChanged double-checks them anyway.
 */
export const POLISH_PROMPT = [
  'You polish emails for a small US trucking company (dispatch, brokers, shippers, loads, invoices, factoring, ' +
  'insurance).',
  'Rewrite the email you are given so it is clear, polite, professional and short.',
  'Rules:',
  '- Keep the writer\'s meaning. Do not add facts, promises, questions or details that are not in the email.',
  '- Keep every name, number, amount, date, time, load number, PO number, phone number, email address and street ' +
  'address exactly as written.',
  '- Write in the same language as the email.',
  '- Plain text only: no markdown, no headings, no bold, no bullet symbols the writer did not use.',
  '- Keep the writer\'s greeting and sign-off. If there is no sign-off, you may end with a simple one such as ' +
  '"Thanks," with no name.',
  '- Never add placeholders such as [Your Name], a subject line, notes, or quotes around the email.',
  'Return only the email text.',
].join('\n')

/**
 * The chat/completions request body for Groq and Cloudflare (both speak the
 * OpenAI format). Low temperature keeps it close to what was written.
 * reasoning_effort goes only to gpt-oss models: others refuse the field.
 * max_tokens is set because Cloudflare's default (256) would cut the email off.
 */
export function polishRequest(model: string, text: string): Record<string, unknown> {
  return {
    model,
    messages: [{ role: 'system', content: POLISH_PROMPT }, { role: 'user', content: text }],
    temperature: 0.3,
    max_tokens: 4096,
    ...(/gpt-oss/i.test(model) ? { reasoning_effort: 'low' } : {}),
  }
}

/** The AI's text with markdown and wrapping taken off, since the email goes out as plain text. */
export function cleanAiText(s: string): string {
  let t = s.replace(/\r\n?/g, '\n').trim()
  t = t.replace(/^```[\w-]*\n([\s\S]*?)\n?```$/, '$1').trim()
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
  t = t.replace(/^#{1,6}[ \t]+/gm, '')
  t = t.replace(/^subject:[^\n]*\n+/i, '')
  t = t.replace(/^[ \t]*\[(?:your|my|sender'?s?)\b[^\]\n]*\][ \t]*$/gim, '')
  if (/^"[^"]*"$/.test(t)) t = t.slice(1, -1)
  return t.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The email text in an AI answer: OpenAI's chat format (Groq, and
 * Cloudflare's /ai/v1 endpoint), or Cloudflare's own result shapes. '' when
 * there is none.
 */
export function aiAnswer(body: unknown): string {
  // deno-lint-ignore no-explicit-any
  const b = body as any
  // deno-lint-ignore no-explicit-any
  const output = Array.isArray(b?.output) ? b.output.find((o: any) => o?.type === 'message') : undefined
  const raw = b?.choices?.[0]?.message?.content ?? b?.result?.choices?.[0]?.message?.content ??
    // deno-lint-ignore no-explicit-any
    b?.result?.response ?? b?.output_text ?? output?.content?.find((c: any) => c?.type === 'output_text')?.text
  return typeof raw === 'string' ? cleanAiText(raw) : ''
}

/** Why an AI service failed, in words for the toast. `code` is its error code, if it sent one. */
export function aiFailReason(status: number, code = ''): string {
  if (status === 401 || status === 403) return 'the key was refused (send a new one with /aikey)'
  if (status === 429) return 'too busy, try again in a minute'
  if (status >= 500) return 'the service is down'
  if (status === 404 || /model/i.test(code)) return 'the model was retired (see ai_model in the README)'
  return 'error ' + status
}

/** One number-like thing in a text. `key` ignores how it is written: $1,850.00 and 1850 share one. */
interface NumberMark {
  kind: 'phone' | 'date' | 'time' | 'number'
  key: string
  /** Dates only: the year, when the text gave one. */
  year?: string
  /** As it was written, for the warning. */
  text: string
}

/**
 * Phones, dates (11/13, Nov 13, 13 Nov, 2026-11-13), times (10:30 AM, 2pm)
 * and numbers (amounts, load and PO numbers). Earlier ones win where they
 * overlap, so the digits of a date or a phone don't count again as numbers.
 */
const NUMBER_MARKS = [
  '(?<phone>(?<!\\d)(?:\\+?1[\\s.-]?)?(?:\\(\\d{3}\\)|\\d{3})[\\s.-]?\\d{3}[\\s.-]\\d{4}(?!\\d))',
  '(?<named>\\b' + MONTH + '\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4}\\b)?)',
  '(?<dayfirst>\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MONTH + '(?:,?\\s+\\d{4}\\b)?)',
  '(?<iso>(?<![\\d-])\\d{4}-\\d{1,2}-\\d{1,2}(?![\\d-]))',
  '(?<slash>(?<![\\d/.])\\d{1,2}/\\d{1,2}(?:/(?:\\d{4}|\\d{2}))?(?![\\d/]))',
  '(?<time>\\b\\d{1,2}(?::\\d{2})?\\s?[ap]\\.?m\\b\\.?|\\b\\d{1,2}:\\d{2}\\b)',
  '(?<num>(?:\\$\\s?)?(?:\\d{1,3}(?:,\\d{3})+(?!\\d)|\\d+)(?:\\.\\d+)?)',
].join('|')

/** A date's mark from its numbers: month, day and maybe a year (two digits mean 20xx). */
function dateMark(text: string, mon: number, day: number, year?: string): NumberMark {
  const y = year ? (year.length === 2 ? '20' + year : year) : undefined
  return { kind: 'date', key: 'd:' + mon + '/' + day, year: y, text }
}

/** Every number-like thing in `text`, once each, in the order they first appear. */
function numberMarks(text: string): NumberMark[] {
  const re = new RegExp(NUMBER_MARKS, 'gi')
  const marks: NumberMark[] = []
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const g = m.groups ?? {}
    const raw = m[0].trim()
    const nums: string[] = [...raw.matchAll(/\d+/g)].map((x) => x[0])
    const monthWord = (raw.match(/[a-z]+/gi) ?? [])
      .find((w) => w.length >= 3 && MONTHS.includes(w.slice(0, 3).toLowerCase()))
    // "we may 2 trucks": a small "may" is the verb, not the month. Read on after it.
    if ((g.named || g.dayfirst) && monthWord === 'may') {
      if (g.named) {
        re.lastIndex = m.index + m[0].indexOf('may') + 3
        continue
      }
      marks.push({ kind: 'number', key: 'n:' + nums[0], text: nums[0] })
      re.lastIndex = m.index + m[0].indexOf(nums[0]) + nums[0].length
      continue
    }
    if (g.phone) {
      marks.push({ kind: 'phone', key: 'p:' + nums.join('').replace(/^1(?=\d{10}$)/, ''), text: raw })
    } else if (g.named || g.dayfirst) {
      const mon = MONTHS.indexOf(monthWord!.slice(0, 3).toLowerCase()) + 1
      marks.push(dateMark(raw, mon, +nums[0], nums.find((n) => n.length === 4)))
    } else if (g.iso) {
      marks.push(dateMark(raw, +nums[1], +nums[2], nums[0]))
    } else if (g.slash) {
      marks.push(dateMark(raw, +nums[0], +nums[1], nums[2]))
    } else if (g.time) {
      let h = +nums[0]
      if (/p\.?m/i.test(raw) && h < 12) h += 12
      if (/a\.?m/i.test(raw) && h === 12) h = 0
      marks.push({ kind: 'time', key: 't:' + h + ':' + (nums[1] ?? '00'), text: raw })
    } else {
      let n = raw.replace(/[$\s,]/g, '')
      if (n.includes('.')) n = n.replace(/0+$/, '').replace(/\.$/, '')
      // A bare 10-digit number is a phone written without dashes.
      const phone = /^\d+$/.test(raw) && (n.length === 10 || (n.length === 11 && n.startsWith('1')))
      marks.push(phone
        ? { kind: 'phone', key: 'p:' + n.slice(-10), text: raw }
        : { kind: 'number', key: 'n:' + n, text: raw })
    }
  }
  const seen = new Set<string>()
  return marks.filter((x) => {
    const id = x.key + '|' + (x.year ?? '')
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** Whether `list` has `mark`. A date without a year matches the same day with any year. */
function hasMark(list: NumberMark[], mark: NumberMark): boolean {
  return list.some((x) => x.key === mark.key && (!x.year || !mark.year || x.year === mark.year))
}

/**
 * The number guard: numbers, amounts, dates, times and phones that are in one
 * text but not the other, so the owner checks them before an AI rewrite goes
 * out. "$1,850", "1850" and "1,850.00" are one amount; "11/13" and "Nov 13"
 * one date. A changed one reads "$1,850 → $1,580", a lost one "11/13 missing",
 * a new one "4412 added".
 */
export function numbersChanged(before: string, after: string): string[] {
  const a = numberMarks(before)
  const b = numberMarks(after)
  const gone = a.filter((x) => !hasMark(b, x))
  const added = b.filter((x) => !hasMark(a, x))
  const out: string[] = []
  for (const g of gone) {
    const i = added.findIndex((x) => x.kind === g.kind)
    out.push(i >= 0 ? g.text + ' → ' + added.splice(i, 1)[0].text : g.text + ' missing')
  }
  return [...out, ...added.map((x) => x.text + ' added')]
}

/** How much text a preview shows: with the lines around it, it stays under Telegram's 4096 characters. */
const DRAFT_CHARS = 2500

/**
 * A preview before ✅ Send, for a reply or a new email. `rows` are plain
 * "label: value" lines (empty values are left out). With `original`, the text
 * is the ✨ polished one, and every number that differs from the owner's own
 * text is listed under it.
 */
export function draftText(o: {
  title?: string
  rows: [string, string][]
  body: string
  original?: string | null
}): string {
  const shown = clip(o.body, DRAFT_CHARS)
  const polished = o.original !== undefined && o.original !== null
  const lines = [
    ...(o.title ? ['<b>' + esc(o.title) + '</b>'] : []),
    ...o.rows.filter(([, v]) => v).map(([k, v]) => '<b>' + esc(k) + ':</b> ' + esc(clip(v, 300))),
    '',
    ...(polished ? ['✨ <i>Polished by AI. ↩ Use mine brings back your text.</i>', ''] : []),
    esc(shown),
    ...(shown.length < o.body.length ? ['(cut here; the whole text goes out)'] : []),
  ]
  const changes = polished ? numbersChanged(o.original!, o.body) : []
  if (changes.length) lines.push('', '⚠️ Check these: ' + esc(clip(changes.join(', '), 300)))
  return lines.join('\n')
}

/**
 * Buttons under a preview. Kind r is a reply (✅ y, 👥 Y, ✕ n, as before),
 * kind n a new email (✅ A, ✕ K). ✨ Polish (E) becomes ↩ Use mine (O) once
 * the text is polished.
 */
export function draftKeyboard(kind: 'r' | 'n', key: string, polished: boolean, replyAll = false): {
  inline_keyboard: Button[][]
} {
  const send: Button = { text: '✅ Send', callback_data: (kind === 'r' ? 'y:' : 'A:') + key }
  const cancel: Button = { text: '✕ Cancel', callback_data: (kind === 'r' ? 'n:' : 'K:') + key }
  const ai: Button = polished
    ? { text: '↩ Use mine', callback_data: 'O:' + kind + ':' + key }
    : { text: '✨ Polish', callback_data: 'E:' + kind + ':' + key }
  if (!replyAll) return { inline_keyboard: [polished ? [send, ai, cancel] : [ai, send, cancel]] }
  return { inline_keyboard: [[send, { text: '👥 Reply all', callback_data: 'Y:' + key }], [ai, cancel]] }
}
