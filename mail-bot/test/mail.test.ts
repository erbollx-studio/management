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
  emailKeyboard,
  type GmailMessage,
  isMuted,
  matchRules,
  parseAddress,
  parseAddressList,
  readableBody,
  readEmail,
  refFromEntities,
  parseRules,
  shouldSkip,
  similarWords,
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

Deno.test('the card is one line: sender → inbox, sender links to Gmail', () => {
  const e = readEmail(message())
  const link = 'https://mail.google.com/mail/u/info@jolgo.app/#all/' + e.id
  const t = cardText({ inbox: 'info@jolgo.app', email: e, link, timeZone: 'Asia/Bishkek' })
  assert.equal(t, '<a href="' + link + '"><b>Heather G</b></a> → info@jolgo.app')
  assert.deepEqual(refFromEntities([{ type: 'text_link', url: link }]), { inbox: 'info@jolgo.app', id: e.id })
})

Deno.test('▾ More adds subject, time, matched words and the text, all escaped', () => {
  const e = readEmail(message())
  const t = cardText({
    inbox: 'info@jolgo.app', email: e, link: 'x', timeZone: 'Asia/Bishkek', tags: ['invoice'], body: readableBody(e, true),
  })
  const lines = t.split('\n')
  assert.equal(lines[1], '<b>FactorGenie System &amp; TMS Integration &lt;MC#1355817&gt;</b>')
  assert.equal(lines[2], '26 Oct, 14:32 · 🏷 invoice')
  assert.ok(t.endsWith('Hi Erbol,\n\nFTP details attached.'), t)
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
  assert.deepEqual(data(emailKeyboard(7, id, 'u', 'min', 2)), ['v:7:' + id, 'd:7:' + id, 's:7:' + id])
  assert.deepEqual(data(emailKeyboard(7, id, 'u', 'more', 2)),
    ['c:7:' + id, 'f:7:' + id, 'p:7:' + id, 'url', 'a:7:' + id, 'd:7:' + id, 's:7:' + id])
  assert.deepEqual(data(emailKeyboard(7, id, 'u', 'full', 0)), ['c:7:' + id, 'url', 'a:7:' + id, 'd:7:' + id, 's:7:' + id])
  const e = readEmail(message({ id }))
  for (const kb of [emailKeyboard(99999, id, 'u', 'more', 9), stopKeyboard(99999, e)]) {
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

Deno.test('the whole email counts; no rules means everything; snippet stands in for lists', () => {
  const e = readEmail(message())
  e.subject = 'Update'
  e.attachments = []
  e.text = 'x '.repeat(3000) + 'Erbol, payment due Friday'
  assert.ok(matchRules(e, ['erbol']).pass)
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

