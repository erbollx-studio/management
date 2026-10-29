// deno test mail-bot/test/
import assert from 'node:assert/strict'
import {
  base64urlToBytes,
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
  wordMatch,
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

Deno.test('the card escapes HTML and carries the inbox + id in its link', () => {
  const e = readEmail(message())
  const link = 'https://mail.google.com/mail/u/info@jolgo.app/#all/' + e.id
  const t = cardText({ inbox: 'info@jolgo.app', email: e, link, preview: readableBody(e, true), timeZone: 'Asia/Bishkek' })
  assert.ok(t.startsWith('📥 <b>info@jolgo.app</b>\n👤 <b>Heather G</b> &lt;heatherg@aladdincap.com&gt;'), t)
  assert.ok(t.includes('<a href="' + link + '">FactorGenie System &amp; TMS Integration &lt;MC#1355817&gt;</a>'), t)
  assert.ok(t.includes('🕒 26 окт., 14:32'), t)
  assert.ok(t.endsWith('📎 Вложений: 1'), t)
  assert.deepEqual(refFromEntities([{ type: 'text_link', url: link }]), { inbox: 'info@jolgo.app', id: e.id })
})

Deno.test('a reply target needs exactly one email link', () => {
  const a = { type: 'text_link', url: 'https://mail.google.com/mail/u/a@x.com/#all/18f0a1' }
  const b = { type: 'text_link', url: 'https://mail.google.com/mail/u/b@x.com/#all/18f0a2' }
  assert.equal(refFromEntities([a, a]) !== null, true)
  assert.equal(refFromEntities([a, b]), null)
  assert.equal(refFromEntities([{ type: 'bold' }]), null)
  assert.equal(refFromEntities(undefined), null)
})

Deno.test('callback data stays under Telegram\'s 64-byte limit', () => {
  const kb = emailKeyboard(99999, '18f0a1b2c3d4e5f6a7b8', 'https://mail.google.com/x', true, false)
  for (const btn of kb.inline_keyboard.flat()) {
    if (btn.callback_data) assert.ok(new TextEncoder().encode(btn.callback_data).length <= 64, btn.callback_data)
  }
  const done = emailKeyboard(1, 'a1', 'u', false, true)
  assert.deepEqual(done.inline_keyboard[0].map((btn) => btn.callback_data), ['f:1:a1'])
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

Deno.test('words match at the start of a word, in any case, ё = е', () => {
  assert.ok(wordMatch('Hi Erbol, see attached', 'erbol'))
  assert.ok(wordMatch('Payments are due', 'payment'))
  assert.ok(wordMatch('Продление страхования', 'страхов'))
  assert.ok(wordMatch('Счёт №45 за октябрь', 'счет'))
  assert.ok(wordMatch('Late  payment notice', 'late payment'))
  assert.ok(!wordMatch('Please display this', 'pay'))
  assert.ok(!wordMatch('anything', '  '))
})

Deno.test('rules: commas mean any word, + means all words', () => {
  assert.deepEqual(parseRules('Payment, Erbol; insurance + payment ,  late   payment\nerbol'),
    ['payment', 'erbol', 'insurance + payment', 'late payment'])
  assert.deepEqual(parseRules(' , ; '), [])
})

Deno.test('an email passes if any rule matches anywhere in it', () => {
  const e = readEmail(message())
  const set = (subject: string, text: string, files: string[] = []) => {
    e.subject = subject
    e.text = text
    e.snippet = ''
    e.attachments = files.map((name) => ({ name, mimeType: 'application/pdf', size: 1 }))
    return e
  }
  assert.deepEqual(matchRules(set('Lunch?', 'hi'), []), { pass: true, tags: [] })
  assert.deepEqual(matchRules(set('Payment for insurance', ''), ['erbol', 'insurance + payment']),
    { pass: true, tags: ['insurance + payment'] })
  assert.equal(matchRules(set('Payment received', ''), ['insurance + payment']).pass, false)
  assert.deepEqual(matchRules(set('Docs', 'Hi Erbol, see attached'), ['erbol']).tags, ['erbol'])
  // The whole body counts, not just the start, and quoted history too.
  assert.ok(matchRules(set('Update', 'x '.repeat(3000) + 'payment due Friday'), ['payment']).pass)
  assert.ok(matchRules(set('Re: load', 'ok\n\nOn Mon, Oct 26, 2026 at 10:00 AM Jerry wrote:\n> payment sent'), ['payment']).pass)
  // Attachment names count.
  assert.ok(matchRules(set('Docs', 'see attached', ['Invoice_4411.pdf']), ['invoice']).pass)
  assert.equal(matchRules(set('Weekly news', 'nothing here'), ['payment', 'erbol']).pass, false)
  // List views have no body: the snippet stands in.
  e.text = ''
  e.subject = 'Weekly update'
  e.snippet = 'Erbol, the truck MC 1355817 is ready'
  e.attachments = []
  assert.deepEqual(matchRules(e, ['1355817', 'erbol']).tags, ['1355817', 'erbol'])
})

Deno.test('the card shows why a filtered email came through', () => {
  const e = readEmail(message())
  const t = cardText({ inbox: 'info@jolgo.app', email: e, link: 'x', preview: '', timeZone: 'Asia/Bishkek', tags: ['payment'] })
  assert.ok(t.startsWith('📥 <b>info@jolgo.app</b> · 🏷 payment\n'), t)
})
