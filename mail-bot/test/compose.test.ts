// ✍️ New email and ✨ Polish. deno test mail-bot/test/
import assert from 'node:assert/strict'
import {
  aiAnswer,
  aiFailReason,
  base64urlToBytes,
  buildNewEmail,
  cleanAiText,
  draftKeyboard,
  draftText,
  encodeHeader,
  numbersChanged,
  parseRecipients,
  polishRequest,
  POLISH_PROMPT,
} from '../supabase/functions/mail-bot/mail.ts'

const utf8 = (b64: string) => new TextDecoder().decode(base64urlToBytes(b64))

/** The raw email as text: headers, and the body decoded. */
function openRaw(raw: string): { head: string; body: string } {
  const message = utf8(raw)
  const cut = message.indexOf('\r\n\r\n')
  return { head: message.slice(0, cut), body: utf8(message.slice(cut + 4).replace(/\r\n/g, '')) }
}

/** What Telegram counts against its 4096 limit: the text after the HTML tags are read. */
function visible(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

// ---------------------------------------------------------------- number guard --

Deno.test('number guard: the same amount, date, time and phone written another way is no change', () => {
  assert.deepEqual(numbersChanged('Pay $1,850 by 11/13.', 'Please pay 1850 by Nov 13.'), [])
  assert.deepEqual(numbersChanged('Total $1,850.00', 'The total is $1,850'), [])
  assert.deepEqual(numbersChanged('Rate 1,850.50', 'Rate $1850.5'), [])
  assert.deepEqual(numbersChanged('Pickup November 13th, 2026', 'Pickup on 11/13/2026'), [])
  assert.deepEqual(numbersChanged('Delivery 13 Nov', 'Delivery Nov 13'), [])
  assert.deepEqual(numbersChanged('due 2026-11-13', 'due 11/13/26'), [])
  assert.deepEqual(numbersChanged('at 2:30 PM', 'at 14:30'), [])
  assert.deepEqual(numbersChanged('by 10am', 'by 10:00 AM'), [])
  assert.deepEqual(numbersChanged('Call (555) 123-4567', 'Call 555-123-4567 or +1 555 123 4567 or 5551234567'), [])
  assert.deepEqual(numbersChanged('rooms 1,2,3', 'rooms 1, 2, 3'), [])
  // The same number twice, or once: still there.
  assert.deepEqual(numbersChanged('Load 8646459. Again: load 8646459', 'Load 8646459'), [])
  // A day without a year matches that day in any year.
  assert.deepEqual(numbersChanged('Nov 13, 2026', 'Nov 13'), [])
})

Deno.test('number guard: a changed, lost or new number is listed', () => {
  assert.deepEqual(numbersChanged('Your premium of $1,850 is due', 'Your premium of $1,580 is due'),
    ['$1,850 → $1,580'])
  assert.deepEqual(numbersChanged('Load #8646459 picks up 11/13 at 10:30 AM', 'Load #8646459 picks up at 10:30 AM'),
    ['11/13 missing'])
  assert.deepEqual(numbersChanged('PO 4411 is ready', 'PO 4411 and 4412 are ready'), ['4412 added'])
  assert.deepEqual(numbersChanged('Call 555-123-4567', 'Call 555-123-4576'), ['555-123-4567 → 555-123-4576'])
  assert.deepEqual(numbersChanged('Load #8646459', 'Load #8646495'), ['8646459 → 8646495'])
  // Paired by kind: amount with amount, date with date.
  assert.deepEqual(numbersChanged('Pay $500 on 11/13', 'Pay $550 on 11/14'), ['$500 → $550', '11/13 → 11/14'])
  assert.deepEqual(numbersChanged('11/13/2026', '11/13/2025'), ['11/13/2026 → 11/13/2025'])
  assert.deepEqual(numbersChanged('at 2:30 PM', 'at 2:30 AM'), ['2:30 PM → 2:30 AM'])
  assert.deepEqual(numbersChanged('Оплата $1,850 до 11/13', 'Оплата $1,580 до 11/13'), ['$1,850 → $1,580'])
})

Deno.test('number guard: "may" the word is not May the month; no numbers, no warning', () => {
  assert.deepEqual(numbersChanged('we may 2 trucks', 'we may send 2 trucks'), [])
  assert.deepEqual(numbersChanged('I have 3 may come', 'I have 3 that may come'), [])
  assert.deepEqual(numbersChanged('May 5', 'May 6'), ['May 5 → May 6'])
  assert.deepEqual(numbersChanged('Hi, thanks!', 'Hello, thank you.'), [])
})

// --------------------------------------------------------------------- new email --

Deno.test('recipients: commas, semicolons, spaces, names; typos come back as bad', () => {
  assert.deepEqual(parseRecipients('a@x.com, B@Y.com'), { ok: ['a@x.com', 'b@y.com'], bad: [] })
  assert.deepEqual(parseRecipients('Anna Lee <anna@x.com>; bob@y.org\ncarl@z.io'),
    { ok: ['anna@x.com', 'bob@y.org', 'carl@z.io'], bad: [] })
  assert.deepEqual(parseRecipients('a@x.com b@y.com a@x.com'), { ok: ['a@x.com', 'b@y.com'], bad: [] })
  assert.deepEqual(parseRecipients('Anna anna@x.com'), { ok: ['anna@x.com'], bad: [] })
  assert.deepEqual(parseRecipients('anna@x, hello'), { ok: [], bad: ['anna@x', 'hello'] })
  assert.deepEqual(parseRecipients('mailto:ap@broker.com.'), { ok: ['ap@broker.com'], bad: [] })
  assert.deepEqual(parseRecipients(''), { ok: [], bad: [] })
})

Deno.test('new email: headers Gmail threads on, UTF-8 text with CRLF lines', () => {
  const raw = buildNewEmail({
    from: 'info@dancargo.com',
    name: 'Dan Cargo',
    to: ['ap@broker.com', 'anna@truckinsure.com'],
    subject: 'Invoice 4411',
    text: 'Hi Anna,\nInvoice 4411 is attached ✅',
    date: new Date(Date.UTC(2026, 10, 4, 12, 0, 0)),
    id: 'abc123',
  })
  const { head, body } = openRaw(raw)
  assert.ok(head.startsWith('From: Dan Cargo <info@dancargo.com>\r\nTo: ap@broker.com, anna@truckinsure.com\r\n'), head)
  assert.ok(head.includes('\r\nSubject: Invoice 4411\r\n'), head)
  assert.ok(head.includes('\r\nDate: Wed, 04 Nov 2026 12:00:00 +0000\r\n'), head)
  assert.ok(head.includes('\r\nMessage-ID: <abc123@dancargo.com>\r\n'), head)
  assert.ok(head.includes('\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64'), head)
  assert.ok(!head.includes('In-Reply-To'), head)
  assert.equal(body, 'Hi Anna,\r\nInvoice 4411 is attached ✅')
})

Deno.test('new email: names and subjects in Russian are encoded; odd names quoted; long To lines fold', () => {
  const to = Array.from({ length: 6 }, (_, i) => 'dispatcher' + i + '@longbrokername.com')
  const { head } = openRaw(buildNewEmail({
    from: 'info@x.com',
    name: 'Dan Cargo, LLC',
    to,
    subject: 'Счёт за октябрь: груз #4411, оплата до 13 ноября',
    text: 'ok',
    date: new Date(),
    id: 'id',
  }))
  assert.ok(head.startsWith('From: "Dan Cargo, LLC" <info@x.com>\r\n'), head)
  for (const line of head.split('\r\n')) assert.ok(line.length <= 78, line)
  const subject = head.match(/Subject: ([\s\S]*?)\r\nDate:/)![1]
  const words = subject.split('\r\n ').map((w) => utf8(w.match(/^=\?UTF-8\?B\?([^?]+)\?=$/)![1]))
  assert.equal(words.join(''), 'Счёт за октябрь: груз #4411, оплата до 13 ноября')
  assert.ok(words.length > 1)
  const toLines = head.match(/To: ([\s\S]*?)\r\nSubject:/)![1].split(',\r\n ').join(', ')
  assert.equal(toLines, to.join(', '))

  const ru = openRaw(buildNewEmail({
    from: 'a@x.com',
    name: 'Эрбол',
    to: ['b@y.com'],
    subject: 's',
    text: 't',
    date: new Date(),
    id: 'i',
  }))
  assert.match(ru.head, /^From: =\?UTF-8\?B\?[^?]+\?= <a@x\.com>\r\n/)
  assert.equal(encodeHeader('Plain subject'), 'Plain subject')
})

// ------------------------------------------------------------------------ polish --

Deno.test('polish request: the owner\'s text, low temperature, low reasoning only for gpt-oss', () => {
  const body = polishRequest('openai/gpt-oss-120b', 'pls pay 1850 by fri')
  assert.equal(body.model, 'openai/gpt-oss-120b')
  assert.equal(body.temperature, 0.3)
  assert.equal(body.reasoning_effort, 'low')
  assert.ok(Number(body.max_tokens) >= 2048)
  assert.deepEqual(body.messages, [
    { role: 'system', content: POLISH_PROMPT },
    { role: 'user', content: 'pls pay 1850 by fri' },
  ])
  assert.equal(polishRequest('@cf/openai/gpt-oss-120b', 'x').reasoning_effort, 'low')
  assert.equal(polishRequest('llama-3.3-70b-versatile', 'x').reasoning_effort, undefined)
  for (const rule of ['clear, polite, professional and short', 'exactly as written', 'same language', 'Plain text',
    'trucking']) {
    assert.ok(POLISH_PROMPT.includes(rule), rule)
  }
})

Deno.test('polish answer: OpenAI and Cloudflare shapes; markdown, code blocks and placeholders come off', () => {
  assert.equal(aiAnswer({ choices: [{ message: { content: 'Hi Anna,\n\nThanks.', reasoning: 'thinking…' } }] }),
    'Hi Anna,\n\nThanks.')
  assert.equal(aiAnswer({ result: { response: 'Hello' }, success: true }), 'Hello')
  const responses = {
    output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'Hey' }] }],
  }
  assert.equal(aiAnswer(responses), 'Hey')
  assert.equal(aiAnswer({ choices: [{ message: { content: null } }] }), '')
  assert.equal(aiAnswer({ error: { message: 'bad' } }), '')
  assert.equal(aiAnswer(null), '')
  assert.equal(cleanAiText('```\nHi **Anna**,\n\n## Payment\nPaid.\n\nThanks,\n[Your Name]\n```'),
    'Hi Anna,\n\nPayment\nPaid.\n\nThanks,')
  assert.equal(cleanAiText('Subject: Invoice\n\nHi,\nok'), 'Hi,\nok')
  assert.equal(cleanAiText('"Hi, see you at 5."'), 'Hi, see you at 5.')
  assert.equal(cleanAiText('He said "yes" and "no"'), 'He said "yes" and "no"')
})

Deno.test('polish failures read plainly', () => {
  assert.match(aiFailReason(401), /key was refused/)
  assert.match(aiFailReason(429), /busy/)
  assert.match(aiFailReason(503), /down/)
  assert.match(aiFailReason(400, 'model_decommissioned'), /model was retired/)
  assert.equal(aiFailReason(400), 'error 400')
})

// ---------------------------------------------------------------------- previews --

Deno.test('preview: rows, the text, and after ✨ Polish a warning for changed numbers', () => {
  const rows: [string, string][] = [['From', 'info@x.com'], ['To', 'a@b.com'], ['Subject', 'Load <4411> & rate']]
  const plain = draftText({ title: '✍️ New email', rows, body: 'Pay $1,850 by 11/13', original: null })
  assert.equal(plain, '<b>✍️ New email</b>\n<b>From:</b> info@x.com\n<b>To:</b> a@b.com\n' +
    '<b>Subject:</b> Load &lt;4411&gt; &amp; rate\n\nPay $1,850 by 11/13')
  const polished = draftText({ rows, body: 'Please pay $1,580 by Nov 13.', original: 'Pay $1,850 by 11/13' })
  assert.ok(polished.includes('✨ <i>Polished by AI.'), polished)
  assert.ok(polished.endsWith('\n\n⚠️ Check these: $1,850 → $1,580'), polished)
  const fine = draftText({ rows, body: 'Please pay $1,850 by Nov 13.', original: 'Pay $1,850 by 11/13' })
  assert.ok(!fine.includes('⚠️'), fine)
  // Empty rows (no "Reply all also goes to") are left out.
  const reply = draftText({ rows: [['↩️ To', 'a@b.com'], ['Reply all also goes to', '']], body: 'x' })
  assert.equal(reply, '<b>↩️ To:</b> a@b.com\n\nx')
})

Deno.test('preview: never over Telegram\'s 4096 characters, even with a long text and many numbers', () => {
  const long = Array.from({ length: 900 }, (_, i) => 'load ' + (1000 + i) + ' $' + (i * 7)).join(' & ')
  const rows: [string, string][] = [
    ['From', 'x'.repeat(500) + '@x.com'],
    ['To', Array.from({ length: 80 }, (_, i) => 'person' + i + '@company.com').join(', ')],
    ['Subject', 'S'.repeat(400)],
  ]
  for (const original of [null, long.replace(/\d/g, '9')]) {
    const text = draftText({ title: '✍️ New email', rows, body: long, original })
    assert.ok(visible(text).length <= 4096, String(visible(text).length))
    assert.ok(text.includes('(cut here; the whole text goes out)'))
  }
})

Deno.test('preview buttons: Polish, then Use mine; reply keeps y / Y / n; callback data under 64 bytes', () => {
  const key = 'Ab3_dE-9xYz0'
  const data = (kb: { inline_keyboard: { callback_data?: string; text: string }[][] }) =>
    kb.inline_keyboard.map((r) => r.map((b) => b.text + '=' + b.callback_data))
  assert.deepEqual(data(draftKeyboard('n', key, false)),
    [[`✨ Polish=E:n:${key}`, `✅ Send=A:${key}`, `✕ Cancel=K:${key}`]])
  assert.deepEqual(data(draftKeyboard('n', key, true)),
    [[`✅ Send=A:${key}`, `↩ Use mine=O:n:${key}`, `✕ Cancel=K:${key}`]])
  assert.deepEqual(data(draftKeyboard('r', key, false)),
    [[`✨ Polish=E:r:${key}`, `✅ Send=y:${key}`, `✕ Cancel=n:${key}`]])
  assert.deepEqual(data(draftKeyboard('r', key, true, true)), [
    [`✅ Send=y:${key}`, `👥 Reply all=Y:${key}`],
    [`↩ Use mine=O:r:${key}`, `✕ Cancel=n:${key}`],
  ])
  for (const kb of [draftKeyboard('n', key, false), draftKeyboard('r', key, true, true)]) {
    for (const b of kb.inline_keyboard.flat()) assert.ok(new TextEncoder().encode(b.callback_data!).length <= 64)
  }
  // The inbox choice for /new: N:<key>:<inbox id>.
  assert.ok(new TextEncoder().encode('N:' + key + ':' + 2147483647).length <= 64)
})
