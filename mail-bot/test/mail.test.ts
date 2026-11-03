// deno test mail-bot/test/
import assert from 'node:assert/strict'
import {
  base64urlToBytes,
  companyDomain,
  describeMute,
  findWord,
  muteEntry,
  stopKeyboard,
  subjectKey,
  buildReply,
  bytesToBase64url,
  cardText,
  classify,
  decide,
  emailKeyboard,
  type GmailMessage,
  inboxName,
  isMuted,
  personFor,
  matchRules,
  parseAddress,
  parseAddressList,
  readableBody,
  readEmail,
  refFromEntities,
  parseRules,
  preview,
  shouldSkip,
  similarWords,
  atLocal,
  fmtWhen,
  isQuiet,
  laterKeyboard,
  laterTime,
  loadMark,
  localParts,
  parseQuiet,
  senderEntry,
  senderStatus,
  taggedIds,
} from '../supabase/functions/mail-bot/mail.ts'

const b64 = (s: string, charset = 'utf-8') => {
  const bytes = charset === 'windows-1251' ? win1251(s) : new TextEncoder().encode(s)
  return bytesToBase64url(bytes)
}

// Enough of windows-1251 for Cyrillic test text.
function win1251(s: string): Uint8Array {
  return Uint8Array.from([...s].map((ch) => {
    const c = ch.charCodeAt(0)
    if (c >= 0x410 && c <= 0x44f) return c - 0x350
    return c
  }))
}

const message = (over: Partial<GmailMessage> = {}): GmailMessage => ({
  id: '18f0a1b2c3d4e5f6',
  threadId: '18f0a1b2c3d4e000',
  labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
  internalDate: String(Date.UTC(2026, 9, 26, 8, 32)),
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: '"Heather G" <HeatherG@aladdincap.com>' },
      { name: 'To', value: 'info@jolgo.app, "Lambert, Bill" <blambert@aladdincap.com>' },
      { name: 'Cc', value: 'jay@aladdincap.com, info@jolgo.app' },
      { name: 'Subject', value: 'FactorGenie System & TMS Integration <MC#1355817>' },
      { name: 'Message-ID', value: '<abc@mail.aladdincap.com>' },
      { name: 'References', value: '<root@mail.aladdincap.com>' },
    ],
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          {
            mimeType: 'text/plain',
            headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }],
            body: { data: b64('Hi Erbol,\r\n\r\nFTP details attached.\r\n\r\nOn Mon, Oct 26, 2026 at 10:00 AM Jerry <jerry@x.com>\r\nwrote:\r\n> old quoted stuff') },
          },
          { mimeType: 'text/html', body: { data: b64('<p>ignored when plain exists</p>') } },
        ],
      },
      {
        mimeType: 'image/png',
        filename: 'logo.png',
        headers: [{ name: 'Content-ID', value: '<logo>' }, { name: 'Content-Disposition', value: 'inline' }],
        body: { attachmentId: 'ATT-LOGO', size: 900 },
      },
      {
        mimeType: 'application/pdf',
        filename: 'Rate con #4411.pdf',
        headers: [{ name: 'Content-Disposition', value: 'attachment; filename="Rate con #4411.pdf"' }],
        body: { attachmentId: 'ATT-PDF', size: 52_000 },
      },
    ],
  },
  ...over,
})

Deno.test('addresses parse with names, quotes and commas inside quotes', () => {
  assert.deepEqual(parseAddress('"Heather G" <HeatherG@aladdincap.com>'), {
    email: 'heatherg@aladdincap.com',
    name: 'Heather G',
    label: 'Heather G',
  })
  assert.deepEqual(parseAddress('jerry@grtplains.com').label, 'jerry@grtplains.com')
  assert.deepEqual(
    parseAddressList('a@x.com, "Lambert, Bill" <b@x.com>,c@x.com').map((a) => a.email),
    ['a@x.com', 'b@x.com', 'c@x.com'],
  )
})

Deno.test('readEmail takes the plain part, real attachments and skips inline logos', () => {
  const e = readEmail(message())
  assert.equal(e.from.email, 'heatherg@aladdincap.com')
  assert.equal(e.subject, 'FactorGenie System & TMS Integration <MC#1355817>')
  assert.ok(e.text.startsWith('Hi Erbol'))
  assert.deepEqual(e.attachments.map((a) => a.name), ['Rate con #4411.pdf'])
  assert.equal(e.attachments[0].attachmentId, 'ATT-PDF')
  assert.equal(e.date.toISOString(), '2026-10-26T08:32:00.000Z')
})

Deno.test('readEmail decodes windows-1251 and falls back to HTML', () => {
  const e = readEmail(message({
    payload: {
      mimeType: 'text/html',
      headers: [{ name: 'Content-Type', value: 'text/html; charset=windows-1251' }],
      body: { data: b64('<html><head><style>p{}</style></head><body><p>Привет&nbsp;мир &amp; все</p><div>Строка</div></body></html>', 'windows-1251') },
    },
  }))
  assert.equal(e.text.trim(), 'Привет мир & все\nСтрока')
})

Deno.test('preview cuts quoted history, full text and forwards keep it', () => {
  const e = readEmail(message())
  assert.equal(readableBody(e, true), 'Hi Erbol,\n\nFTP details attached.')
  assert.ok(readableBody(e, false).includes('old quoted stuff'))
  const fw = readEmail(message())
  fw.subject = 'FW: FW: Request for FTP Credentials'
  fw.text = 'FYI\n\nFrom: Support <support@factorgenie.com>\nSent: Friday\n\nHere are the FTP details.'
  assert.ok(readableBody(fw, true).includes('Here are the FTP details.'))
  const ru = readEmail(message())
  ru.text = 'Добрый день, счёт во вложении.\n\n26 окт. 2026 г., в 10:00, Иван <ivan@x.ru> написал:\n> старое'
  assert.equal(readableBody(ru, true), 'Добрый день, счёт во вложении.')
})

Deno.test('trailing spaces go, letters at line ends stay', () => {
  const e = readEmail(message())
  e.text = 'Hola  \nUna factura\u00a0\nTabu\\\nok'
  assert.equal(readableBody(e, false), 'Hola\nUna factura\nTabu\\\nok')
})

Deno.test('shouldSkip keeps inbox mail and drops sent, spam and skipped tabs', () => {
  const skip = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL']
  assert.equal(shouldSkip(['INBOX', 'UNREAD', 'CATEGORY_UPDATES'], skip), false)
  assert.equal(shouldSkip(['INBOX', 'CATEGORY_PROMOTIONS'], skip), true)
  assert.equal(shouldSkip(['SENT', 'INBOX'], skip), true)
  assert.equal(shouldSkip(['UNREAD', 'Label_12'], skip), true)
})

Deno.test('mute matches an address or a whole domain, not lookalikes', () => {
  const muted = ['grtplains.com', 'noreply@cloudflare.com']
  assert.ok(isMuted(muted, 'britta@grtplains.com'))
  assert.ok(isMuted(muted, 'x@mail.grtplains.com'))
  assert.ok(!isMuted(muted, 'x@notgrtplains.com'))
  assert.ok(isMuted(muted, 'noreply@cloudflare.com'))
  assert.ok(!isMuted(muted, 'team@cloudflare.com'))
})

Deno.test('the card: template, From and To with names, subject linked to Gmail, the first lines', () => {
  const e = readEmail(message())
  const link = 'https://mail.google.com/mail/u/info@jolgo.app/#all/' + e.id
  const inbox = { email: 'info@jolgo.app', name: 'Jolgo' }
  const t = cardText({ label: '🧾 Invoice / payment', email: e, inbox, link, timeZone: 'Asia/Bishkek', body: preview(e, 300) })
  assert.equal(t, [
    '<b>🧾 Invoice / payment</b>',
    '<b>From:</b> Heather G · heatherg@aladdincap.com',
    '<b>To:</b> Jolgo · info@jolgo.app',
    '<b>Subject:</b> <a href="' + link + '">FactorGenie System &amp; TMS Integration &lt;MC#1355817&gt;</a>',
    'Hi Erbol, FTP details attached.',
  ].join('\n'))
  assert.deepEqual(refFromEntities([{ type: 'text_link', url: link }]), { inbox: 'info@jolgo.app', id: e.id })
  // No template line and no names: just the addresses.
  e.from = parseAddress('jerry@grtplains.com')
  const bare = cardText({ label: '', email: e, inbox: { email: 'info@jolgo.app', name: '' }, link, timeZone: 'Asia/Bishkek', body: '' })
  assert.deepEqual(bare.split('\n').slice(0, 2), ['<b>From:</b> jerry@grtplains.com', '<b>To:</b> info@jolgo.app'])
})

Deno.test('the inbox name: the one Gmail has, else the one the email used', () => {
  const e = readEmail(message())
  assert.equal(inboxName('Dan Cargo', 'info@jolgo.app', e), 'Dan Cargo')
  assert.equal(inboxName('', 'blambert@aladdincap.com', e), 'Lambert, Bill')
  assert.equal(inboxName(null, 'info@jolgo.app', e), '')
})

Deno.test('the first lines: quotes cut, one paragraph, clipped; the snippet when there is no text', () => {
  const long = readEmail(message({ payload: { mimeType: 'text/plain', body: { data: b64('Hello team,\n\n' + 'word '.repeat(100)) } } }))
  const p = preview(long, 300)
  assert.ok(p.startsWith('Hello team, word word'), p)
  assert.ok(p.length <= 302 && p.endsWith(' …'), p)
  const empty = readEmail(message({ snippet: 'Your invoice &amp; receipt', payload: { mimeType: 'text/plain' } }))
  assert.equal(preview(empty, 300), 'Your invoice & receipt')
})

Deno.test('▾ More adds time, the words that chose the template and the text, all escaped', () => {
  const e = readEmail(message())
  const t = cardText({
    label: '🧾 Invoice / payment', inbox: { email: 'info@jolgo.app', name: '' }, email: e, link: 'x',
    timeZone: 'Asia/Bishkek', details: true, tags: ['invoice'], body: readableBody(e, true),
  })
  assert.ok(t.endsWith('</a>\n🕐 26 Oct, 14:32 · 🏷 invoice\n\nHi Erbol,\n\nFTP details attached.'), t)
})

// Templates on a trucking inbox: [subject, body, sender, files, expected top line or '' = daily list].
const PEOPLE = [
  { entry: 'anna@truckinsure.com', name: 'Anna Lee', note: 'insurance agent' },
  { entry: 'aladdincap.com', name: '', note: '' },
]
const templateCases: [string, string, string, string[], string][] = [
  ['Final notice: policy #A-4411 past due', 'Your premium of $1,850 was due Oct 30.', 'billing@progressive.com', [],
    '🔴 Insurance payment · URGENT'],
  ['Notice of cancellation', 'Your insurance coverage ends on Nov 10.', 'notices@progressive.com', [], '🔴 Insurance · URGENT'],
  ['Premium invoice for policy #4411', 'Please see attached.', 'billing@progressive.com', [], '💰 Insurance payment'],
  ['Оплата страховки за октябрь', 'Счёт во вложении', 'buh@company.kg', [], '💰 Insurance payment'],
  ['Docs', 'see attached', 'jerry@grtplains.com', ['COI_Invoice_4411.pdf'], '💰 Insurance payment'],
  ['Remittance for load #88213', 'Payment of $2,450 was sent by ACH today.', 'ar@broker.com', [], '🧾 Invoice / payment'],
  ['Your receipt from Anthropic', 'Receipt #2117. Read our privacy policy.', 'invoice@mail.anthropic.com', [],
    '🧾 Invoice / payment'],
  ['Your Premium plan invoice', 'Thanks for upgrading. See our refund policy.', 'billing@saas.io', [], '🧾 Invoice / payment'],
  ['Quick question about the new truck', 'Can you send me the VIN?', 'anna@truckinsure.com', [],
    '⭐ Anna Lee · insurance agent'],
  ['Policy renewal quote', 'Attached is your quote.', 'anna@truckinsure.com', [], '⭐ Anna Lee · insurance agent'],
  ['Invoice 991', 'Due Friday.', 'anna@truckinsure.com', [], '🧾 Invoice / payment · ⭐ Anna Lee'],
  ['Can you call me?', 'About the load.', 'Heather G <heatherg@aladdincap.com>', [], '⭐ Heather G'],
  ['Booking confirmed', 'Free cancellation. See our cancellation policy and privacy policy.', 'hotel@booking.com', [], ''],
  ['Lunch tomorrow?', 'Are you free at 1?', 'friend@gmail.com', [], ''],
  // Broker mail: the money and insurance words sit in signatures, footers, load terms and old replies.
  ['RE: Axle Logistics, LLC Rate Confirmation for 3711257',
    'Received, the driver is on the way.\n\nThanks,\nKevin Ellis\nAxle Logistics\nPartnering with Jet Capital if you need factoring?',
    'kevin.ellis@axlelogistics.com', ['image001.jpg'], ''],
  ['Dry Van: WELLAND, ON → VICTORIA, TX | PU TODAY | $2800',
    'Pick up today 14:00 in Welland, deliver Thursday in Victoria. 53ft dry van, no hazmat. Driver must have TWIC. ' +
    'Call me if interested, the shipper is waiting for an answer before noon.\n\nBreanna Kopp\nCarrier Sales\n' +
    '7400 W 132nd St, Overland Park, KS 66210\n\nWWEX PODS / INVOICES / BILLING: afndispatch@example.com',
    'breanna.kopp@em.wwex.com', [], ''],
  ['Re: SPI Logistics - Load documents for load SPT-731186',
    'Got it, thank you!\n\nTo register or to view your pending payments go to https://secure.example.com',
    'scarrion@spi3pl.com', [], ''],
  ['Re: Glade Spring, VA to Amsterdam, NY VIN# 8180-41',
    'Driver will be there at 8.\n\nOn Mon, Nov 2, 2026 at 9:00 AM Grace <graced@lunkerlogistics.com> wrote:\n' +
    '> IF ANY DAMAGE IS FOUND IN THE TRAILER, YOU WILL FORFEIT PAYMENT.',
    'dispatch@rahtrans.com', [], ''],
  ['Hotshot 40ft loads', 'Dedicated lane, 5 loads a week. Truck will be paid for loaded miles and deadhead. Cargo coverage $100k.',
    'peter@rxo.com', [], ''],
  ['Re: IGT Logistics Rate Confirmation for order: 0091544',
    'Pick-up number policy: for security reasons the number is sent only after the driver checks in. TONU if cancelled.',
    'ops@igt.com', [], ''],
  ['You just received a payment from eCapital!💰🎉', 'Hi RAH TRANS INC, a payment was sent to your bank.', 'wallet@ecapital.com',
    [], '🧾 Invoice / payment'],
  ['Hi', 'Thanks!\nInvoice for load 4411 is attached, please pay by Friday.', 'ar@broker.com', [], '🧾 Invoice / payment'],
]

for (const [subject, body, sender, files, expected] of templateCases) {
  Deno.test(`template: "${subject}" → ${expected || 'daily list'}`, () => {
    const e = readEmail(message())
    e.subject = subject
    e.text = body
    e.from = parseAddress(sender)
    e.attachments = files.map((name) => ({ name, mimeType: 'application/pdf', size: 1 }))
    const v = classify(e, PEOPLE, [])
    assert.equal(v.label, expected, JSON.stringify(v))
    assert.equal(v.kind === 'none', expected === '')
  })
}

// Real subjects from the owner's inboxes: load emails, and money emails that must not be taken for them.
const loadSubjects = [
  'ALC Load #8646459 - PAYMENT DELAY - LOAD DOCUMENTATION',
  'Standard Delivery Receipt #0290291',
  'Re: Standard Delivery Receipt #0290291',
  'Question related to PO 38634375 - Scale Ticket & Pics Required',
  'RE: Axle Logistics, LLC Rate Confirmation for 3711257',
  'TQL PO 39042149 eRate Confirmation',
  'Carrier Load Tender LD754137 (Load ID)',
  'Las Vegas, NV to Rocklin, CA 11/3',
  'Dry Van: WELLAND, ON → VICTORIA, TX | PU TODAY | $2800',
  'RANCHO CUCAMONGA, CA >> KANSAS CITY MO - VAN 11/02 1200',
  'Emporia, KS to Laramie, WY Opportunity',
  'San Diego CA to  NC',
  'CA-NV',
  'Invoice for lumper receipt, load 4411',
  'POD and BOL attached',
  'Pick-up tomorrow 8am',
]
const moneySubjects = [
  'You just received a payment from eCapital!💰🎉',
  'Settlement Summary for check date 10/23/2026',
  'City of Markham, IL Invoice# 73000390002-11052026 Reminder',
  'Invoice file of customer 5216686 generated for the billing period',
  'Your eCapital Account Payment History Report',
  'NM TAP - Payment Submission',
  'OK to pay invoice NY office',
  'PAYMENT RECEIVED IN FULL - OK',
  'Final notice: policy #A-4411 past due',
  'Download your statement',
  'P.O. Box change for remittance',
]

Deno.test('load emails are found by their subject; money subjects are not taken for them', () => {
  for (const s of loadSubjects) assert.ok(loadMark(s), s)
  for (const s of moneySubjects) assert.equal(loadMark(s), '', s)
})

Deno.test('the money list: by company domain, parent domains count, free mail by address', () => {
  assert.equal(senderEntry('wallet@ecapital.com'), 'ecapital.com')
  assert.equal(senderEntry('friend@gmail.com'), 'friend@gmail.com')
  const senders = { 'ecapital.com': 'allowed', 'friend@gmail.com': 'denied' }
  assert.equal(senderStatus(senders, 'reports@notify.ecapital.com'), 'allowed')
  assert.equal(senderStatus(senders, 'friend@gmail.com'), 'denied')
  assert.equal(senderStatus(senders, 'other@gmail.com'), undefined)
  assert.equal(senderStatus(senders, 'x@notecapital.com'), undefined)
})

Deno.test('decide: 🔴 and ⭐ always, loads never, money only from allowed senders, a new one asked once', () => {
  const email = (subject: string, body: string, sender: string) => {
    const e = readEmail(message())
    e.subject = subject
    e.text = body
    e.from = parseAddress(sender)
    e.attachments = []
    return e
  }
  const people = [{ entry: 'anna@truckinsure.com', name: 'Anna Lee', note: '' }]
  const senders: Record<string, string> = { 'ecapital.com': 'allowed', 'broker.com': 'denied', 'nicusa.com': 'asked' }
  const go = (e: ReturnType<typeof email>) => decide(e, people, [], senders)

  assert.equal(go(email('You just received a payment', 'Hi', 'wallet@ecapital.com')).send, 'chat')
  const fresh = go(email('Invoice file of customer 5216686', 'Attached.', 'pspbilling@citybilling.com'))
  assert.deepEqual([fresh.send, fresh.asking, fresh.sender], ['ask', true, 'citybilling.com'])
  const waiting = go(email('Invoice file of customer 5216687', 'Attached.', 'pspbilling@nicusa.com'))
  assert.deepEqual([waiting.send, waiting.asking], ['list', true])
  assert.equal(go(email('Payment for October', 'Hi', 'ar@broker.com')).send, 'list')
  // A load email stays out even with "payment" and an allowed sender...
  const load = go(email('ALC Load #8646459 - PAYMENT DELAY', 'Docs missing.', 'info@ecapital.com'))
  assert.deepEqual([load.send, load.load], ['list', 'Load #8646459'])
  // ...but urgent insurance and your people come from anyone, loads or not.
  assert.equal(go(email('Notice of cancellation', 'Your insurance ends Nov 10.', 'x@unknown.com')).send, 'chat')
  assert.equal(go(email('Load #4411 question', 'Call me', 'anna@truckinsure.com')).send, 'chat')
  assert.equal(go(email('Lunch?', 'At 1?', 'friend@gmail.com')).send, 'list')
  // The inbox's own words come, except on load emails.
  assert.equal(decide(email('Hi Erbol', 'Erbol, call me', 'x@y.com'), [], ['erbol'], {}).send, 'chat')
  assert.equal(decide(email('Load #12 for Erbol', 'Erbol', 'x@y.com'), [], ['erbol'], {}).send, 'list')
})

Deno.test('time: the clock in Bishkek, and moments from it', () => {
  const tz = 'Asia/Bishkek' // UTC+6
  assert.deepEqual(localParts(new Date('2026-11-03T17:30:00Z'), tz), { y: 2026, m: 11, d: 3, h: 23, min: 30 })
  assert.deepEqual(localParts(new Date('2026-11-03T18:05:00Z'), tz), { y: 2026, m: 11, d: 4, h: 0, min: 5 })
  assert.equal(atLocal(tz, 2026, 11, 4, 9).toISOString(), '2026-11-04T03:00:00.000Z')
  assert.equal(atLocal(tz, 2026, 11, 31, 9).toISOString(), '2026-12-01T03:00:00.000Z') // rolls over
  assert.equal(atLocal('America/Chicago', 2026, 7, 1, 9).toISOString(), '2026-07-01T14:00:00.000Z')
})

Deno.test('quiet hours: 22-7 runs past midnight; off and nonsense mean never', () => {
  const tz = 'Asia/Bishkek'
  const at = (h: number) => atLocal(tz, 2026, 11, 3, h, 30)
  const night = parseQuiet('22-7')
  assert.deepEqual(night, { from: 22, to: 7 })
  assert.deepEqual([21, 22, 23, 0, 3, 6, 7, 12].map((h) => isQuiet(at(h), tz, night)),
    [false, true, true, true, true, true, false, false])
  const nap = parseQuiet('13 - 15')
  assert.deepEqual([12, 13, 14, 15].map((h) => isQuiet(at(h), tz, nap)), [false, true, true, false])
  assert.equal(parseQuiet('off'), null)
  assert.equal(parseQuiet('25-7'), null)
  assert.equal(parseQuiet('7-7'), null)
  assert.equal(isQuiet(at(23), tz, null), false)
})

Deno.test('⏰ later: in an hour, tonight at 19:00, tomorrow at 9:00; "tonight" only before 18:00', () => {
  const tz = 'Asia/Bishkek'
  const now = atLocal(tz, 2026, 11, 30, 15, 20)
  assert.equal(laterTime('h', now, tz).getTime() - now.getTime(), 60 * 60_000)
  assert.equal(laterTime('e', now, tz).toISOString(), atLocal(tz, 2026, 11, 30, 19).toISOString())
  assert.equal(laterTime('m', now, tz).toISOString(), atLocal(tz, 2026, 12, 1, 9).toISOString()) // next month
  assert.equal(fmtWhen(laterTime('e', now, tz), now, tz), 'today at 19:00')
  assert.equal(fmtWhen(laterTime('m', now, tz), now, tz), 'tomorrow at 9:00')
  assert.equal(fmtWhen(laterTime('h', now, tz), now, tz), 'today at 16:20')
  const choices = (at: Date) => laterKeyboard(1, 'abc', at, tz).inline_keyboard.map((r) => r[0].callback_data)
  assert.deepEqual(choices(now), ['W:1:abc:h', 'W:1:abc:e', 'W:1:abc:m', 'c:1:abc'])
  assert.deepEqual(choices(atLocal(tz, 2026, 11, 30, 18, 30)), ['W:1:abc:h', 'W:1:abc:m', 'c:1:abc'])
})

Deno.test('tag: emails tagged by hand or by a Gmail filter, one per conversation, the newest', () => {
  const TAG = 'Label_77'
  const records = [
    // Tagging a 3-message conversation in Gmail tags all three.
    { labelsAdded: [
      { message: { id: '18f0a1000000000a', threadId: 't1' }, labelIds: [TAG] },
      { message: { id: '18f0a1000000000c', threadId: 't1' }, labelIds: [TAG] },
      { message: { id: '18f0a1000000000b', threadId: 't1' }, labelIds: [TAG] },
    ] },
    // Starred, not tagged.
    { labelsAdded: [{ message: { id: '18f0a1000000000d', threadId: 't2' }, labelIds: ['STARRED'] }] },
    // Arrived with the tag on (a Gmail filter), and one that arrived without it.
    { messagesAdded: [
      { message: { id: '18f0a1000000000e', threadId: 't3', labelIds: ['INBOX', TAG] } },
      { message: { id: '18f0a1000000000f', threadId: 't4', labelIds: ['INBOX'] } },
    ] },
  ]
  assert.deepEqual(taggedIds(records, TAG), ['18f0a1000000000c', '18f0a1000000000e'])
  assert.deepEqual(taggedIds([], TAG), [])
})

Deno.test('template: the inbox\'s own words come after the templates', () => {
  const e = readEmail(message())
  e.subject = 'Can you call me?'
  e.text = 'Hi Erbol, quick question.'
  e.from = parseAddress('jerry@grtplains.com')
  assert.deepEqual(classify(e, [], ['erbol']), { kind: 'words', label: '🏷 erbol', tags: ['erbol'] })
  assert.equal(classify(e, [], []).kind, 'none')
  assert.equal(personFor(PEOPLE, 'x@mail.aladdincap.com')?.entry, 'aladdincap.com')
  assert.equal(personFor(PEOPLE, 'x@notaladdincap.com'), null)
})

Deno.test('a reply target needs exactly one email link', () => {
  const a = { type: 'text_link', url: 'https://mail.google.com/mail/u/a@x.com/#all/18f0a1' }
  const b = { type: 'text_link', url: 'https://mail.google.com/mail/u/b@x.com/#all/18f0a2' }
  assert.equal(refFromEntities([a, a]) !== null, true)
  assert.equal(refFromEntities([a, b]), null)
  assert.equal(refFromEntities([{ type: 'bold' }]), null)
  assert.equal(refFromEntities(undefined), null)
})

Deno.test('buttons: one row when small, more when open; callback data under 64 bytes', () => {
  const id = '18f0a1b2c3d4e5f6a7b8'
  const data = (kb: { inline_keyboard: { callback_data?: string; text: string }[][] }) =>
    kb.inline_keyboard.flat().map((b) => b.callback_data ?? 'url')
  assert.deepEqual(data(emailKeyboard(7, id, 'u', 'min', 2)),
    ['v:7:' + id, 'R:7:' + id, 'T:7:' + id, 'd:7:' + id, 's:7:' + id])
  assert.deepEqual(data(emailKeyboard(7, id, 'u', 'more', 2)),
    ['c:7:' + id, 'f:7:' + id, 'p:7:' + id, 'url', 'R:7:' + id, 'T:7:' + id, 'a:7:' + id, 'd:7:' + id, 's:7:' + id])
  assert.deepEqual(data(emailKeyboard(7, id, 'u', 'full', 0)),
    ['c:7:' + id, 'url', 'R:7:' + id, 'T:7:' + id, 'a:7:' + id, 'd:7:' + id, 's:7:' + id])
  // A money email from a new sender: ✓ Allow / ✕ Not money on top.
  const ask = emailKeyboard(7, id, 'u', 'min', 0, 'nicusa.com')
  assert.deepEqual(data(ask).slice(0, 2), ['G:7:' + id, 'B:7:' + id])
  assert.equal(ask.inline_keyboard[0][0].text, '✓ Allow nicusa.com')
  const e = readEmail(message({ id }))
  const kbs = [emailKeyboard(99999, id, 'u', 'more', 9, 'x'.repeat(80)), stopKeyboard(99999, e),
    laterKeyboard(99999, id, new Date(), 'Asia/Bishkek')]
  for (const kb of kbs) {
    for (const d of data(kb)) assert.ok(new TextEncoder().encode(d).length <= 64, d)
  }
})

Deno.test('🔕 choices: sender, company (not for gmail.com), emails like this', () => {
  const e = readEmail(message())
  assert.deepEqual(stopKeyboard(3, e).inline_keyboard.map((r) => r[0].callback_data),
    ['M:3:' + e.id + ':s', 'M:3:' + e.id + ':d', 'M:3:' + e.id + ':t', 'c:3:' + e.id])
  e.from = parseAddress('Friend <friend@gmail.com>')
  assert.deepEqual(stopKeyboard(3, e).inline_keyboard.map((r) => r[0].callback_data),
    ['M:3:' + e.id + ':s', 'M:3:' + e.id + ':t', 'c:3:' + e.id])
  assert.equal(companyDomain('a@gmail.com'), null)
  assert.equal(companyDomain('a@aladdincap.com'), 'aladdincap.com')
})

Deno.test('🔕 "emails like this" ignores numbers, dates and Re:, and only that sender', () => {
  assert.equal(subjectKey('Re: Your secure link to Claude.ai is here | 2026-10-15 21:27:38'),
    subjectKey('Your secure link to Claude.ai is here | 2026-10-14 10:46:15'))
  assert.notEqual(subjectKey('Settlement Report -- for AAJ COM'), subjectKey('Over Advance Details'))
  const e = readEmail(message())
  e.from = parseAddress('no-reply@mail.anthropic.com')
  e.subject = 'Your secure link to Claude.ai is here | 2026-10-14 10:46:15'
  const entry = muteEntry(e, 't')!
  assert.ok(isMuted([entry], 'no-reply@mail.anthropic.com', 'Your secure link to Claude.ai is here | 2026-10-29 08:00:00'))
  assert.ok(!isMuted([entry], 'no-reply@mail.anthropic.com', '$100 USD in API credits was added'))
  assert.ok(!isMuted([entry], 'other@mail.anthropic.com', 'Your secure link to Claude.ai is here | 2026-10-29 08:00:00'))
  assert.equal(muteEntry(e, 's'), 'no-reply@mail.anthropic.com')
  assert.equal(muteEntry(e, 'd'), 'mail.anthropic.com')
  assert.equal(describeMute('aladdincap.com'), 'everyone at aladdincap.com')
  // A subject with " :: " in it still works, and so does a sender without an @.
  e.from = parseAddress('reports@factor.com')
  e.subject = 'Weekly :: report 12'
  const odd = muteEntry(e, 't')!
  assert.ok(isMuted([odd], 'reports@factor.com', 'Weekly :: report 13'))
  assert.equal(describeMute(odd), 'emails like "weekly :: report #" from reports@factor.com')
  assert.ok(isMuted(['undisclosed-recipients'], 'undisclosed-recipients'))
  e.from = parseAddress('')
  assert.equal(muteEntry(e, 's'), null)
  assert.equal(companyDomain('x@sbcglobal.net'), null)
  assert.equal(describeMute(entry), 'emails like "your secure link to claude.ai is here | #-#-# #:#:#" from no-reply@mail.anthropic.com')
})

Deno.test('reply threads correctly; reply-all drops yourself and duplicates', () => {
  const e = readEmail(message())
  const decode = (raw: string) => new TextDecoder().decode(base64urlToBytes(raw))

  const one = buildReply(e, 'info@jolgo.app', 'Thanks, received ✅', false)
  assert.deepEqual(one.to, ['heatherg@aladdincap.com'])
  assert.deepEqual(one.cc, [])
  const raw = decode(one.raw)
  const [head, body] = raw.split('\r\n\r\n')
  assert.ok(head.includes('From: info@jolgo.app\r\nTo: heatherg@aladdincap.com\r\n'), head)
  assert.ok(head.includes('Subject: Re: FactorGenie System & TMS Integration <MC#1355817>'), head)
  assert.ok(head.includes('In-Reply-To: <abc@mail.aladdincap.com>'), head)
  assert.ok(head.includes('References: <root@mail.aladdincap.com> <abc@mail.aladdincap.com>'), head)
  assert.equal(new TextDecoder().decode(base64urlToBytes(body.replace(/\r\n/g, ''))), 'Thanks, received ✅')

  const all = buildReply(e, 'info@jolgo.app', 'ok', true)
  assert.deepEqual(all.cc, ['blambert@aladdincap.com', 'jay@aladdincap.com'])

  e.subject = 'Re: Счёт за октябрь'
  e.replyTo = 'billing@aladdincap.com'
  const ru = decode(buildReply(e, 'info@jolgo.app', 'ok', false).raw)
  assert.ok(ru.includes('To: billing@aladdincap.com\r\n'), ru)
  const subject = ru.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)![1]
  assert.equal(new TextDecoder().decode(base64urlToBytes(subject)), 'Re: Счёт за октябрь')
})

Deno.test('words: start of a word, any case, ё = е, whole words when asked', () => {
  assert.equal(findWord('Hi Erbol, see attached', 'erbol*'), 'erbol')
  assert.equal(findWord('Payments are due', 'payment*'), 'payments')
  assert.equal(findWord('Продление страхования', 'страхов*'), 'страхования')
  assert.equal(findWord('Счёт №45 за октябрь', 'счет'), 'счет')
  assert.equal(findWord('Late  payment notice', 'late payment*'), 'late  payment')
  assert.equal(findWord('Please display this', 'pay*'), '')
  assert.equal(findWord('Achieve more', 'ach'), '')
  assert.equal(findWord('anything', '  '), '')
})

Deno.test('rules: commas mean any rule, + means all words', () => {
  assert.deepEqual(parseRules('Payment, Erbol; insurance + payment ,  late   payment\nerbol'),
    ['payment', 'erbol', 'insurance + payment', 'late payment'])
  assert.deepEqual(parseRules(' , ; '), [])
})

Deno.test('similar words come with the family', () => {
  assert.ok(similarWords('payment').includes('invoice'))
  assert.ok(similarWords('оплата').includes('payment'))
  assert.ok(similarWords('insurance').includes('страхов'))
  assert.deepEqual(similarWords('erbol'), [])
})

// The owner's real case: "payment + insurance, erbol" on a trucking inbox.
const RULES = ['payment + insurance', 'erbol']
const cases: [string, string, string, string[], string | null][] = [
  // [subject, body, sender, attachments, expected tag or null = held back]
  ['Premium invoice for policy #4411', 'Please see attached.', 'billing@progressive.com', [], 'invoice + premium'],
  ['Insurance payment received', 'Thanks!', 'ar@aladdincap.com', [], 'payment + insurance'],
  ['Оплата страховки за октябрь', 'Счёт во вложении', 'buh@company.kg', [], 'оплата + страховки'],
  ['COI and invoice', 'Attached for load 4411', 'broker@loads.com', [], 'invoice + coi'],
  ['Docs', 'see attached', 'jerry@grtplains.com', ['Insurance_Invoice_4411.pdf'], 'invoice + insurance'],
  ['Can you call me?', 'Hi Erbol, quick question about the load.', 'heatherg@aladdincap.com', [], 'erbol'],
  ['Lunch tomorrow?', 'Are you free at 1?', 'friend@gmail.com', [], null],
  ['Your receipt from Anthropic', 'Receipt #2117. Read our privacy policy.', 'invoice@mail.anthropic.com', [], null],
  ['Claim your $100 off', 'Cloudflare Connect is almost sold out.', 'em@em1.cloudflare.com', [], null],
  ['Insurance renewal reminder', 'Your policy renews on Nov 1.', 'agent@insure.com', [], null],
]

for (const [subject, body, sender, files, expected] of cases) {
  Deno.test(`"${subject}" ${expected ? 'comes through as ' + expected : 'is held back'}`, () => {
    const e = readEmail(message())
    e.subject = subject
    e.text = body
    e.from = parseAddress(sender)
    e.attachments = files.map((name) => ({ name, mimeType: 'application/pdf', size: 1 }))
    const r = matchRules(e, RULES)
    assert.equal(r.pass, expected !== null, JSON.stringify(r))
    if (expected) assert.ok(r.tags.includes(expected), JSON.stringify(r))
  })
}

Deno.test('only the subject, sender, files and first lines count; no rules means everything; snippet for lists', () => {
  const e = readEmail(message())
  e.subject = 'Update'
  e.attachments = []
  e.text = 'Erbol, payment due Friday.\n\n' + 'x '.repeat(3000)
  assert.ok(matchRules(e, ['erbol']).pass)
  e.text = 'x '.repeat(3000) + 'Erbol, payment due Friday'
  assert.equal(matchRules(e, ['erbol']).pass, false)
  e.text = 'ok\n\nOn Mon, Oct 26, 2026 at 10:00 AM Jerry wrote:\n> erbol said hi'
  assert.ok(matchRules(e, ['erbol']).pass)
  assert.deepEqual(matchRules(e, []), { pass: true, tags: [] })
  assert.equal(matchRules(e, ['tax']).pass, false)
  e.text = ''
  e.snippet = 'Erbol, the truck MC 1355817 is ready'
  assert.deepEqual(matchRules(e, ['1355817', 'erbol']).tags, ['1355817', 'erbol'])
  e.snippet = 'Taxi receipt for Tuesday'
  assert.equal(matchRules(e, ['tax']).pass, false)
})

