// Runs Code.gs against fake Gmail / Telegram / Apps Script services.
// Usage: node test/harness.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HUB = 'erbolllx@gmail.com';

// Fake clock: Telegram long-polls advance it instead of waiting.
let clock = Date.now();
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(clock); }
  static now() { return clock; }
}

function makeEnv() {
  const props = {};
  const calls = [];
  const messages = [];
  const triggers = [];
  const logs = [];
  const replies = [];
  let queued = [];
  let uuid = 0;
  let nextUpdate = 1;

  class Msg {
    constructor(o) {
      Object.assign(this, {
        to: HUB, cc: '', bcc: '', replyTo: '', headers: {}, raw: '', body: '', html: '',
        unread: true, archived: false, draft: false, trash: false, attachments: [], date: new Date(clock),
      }, o);
    }
    getId() { return this.id; }
    getFrom() { return this.from; }
    getTo() { return this.to; }
    getCc() { return this.cc; }
    getBcc() { return this.bcc; }
    getReplyTo() { return this.replyTo; }
    getHeader(n) { return this.headers[n] || ''; }
    getRawContent() { this.rawRead = true; return this.raw; }
    getSubject() { return this.subject; }
    getDate() { return this.date; }
    getPlainBody() { return this.body; }
    getBody() { return this.html; }
    getAttachments() { return this.attachments; }
    isUnread() { return this.unread; }
    isDraft() { return this.draft; }
    isInTrash() { return this.trash; }
    markRead() { this.unread = false; }
    getThread() { const m = this; return { moveToArchive() { m.archived = true; } }; }
    reply(t, o) { replies.push({ id: this.id, t, o, all: false }); }
    replyAll(t, o) { replies.push({ id: this.id, t, o, all: true }); }
  }

  const store = {
    getProperties: () => Object.assign({}, props),
    getProperty: (k) => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = String(v); },
    setProperties: (o) => Object.keys(o).forEach((k) => { props[k] = String(o[k]); }),
    deleteProperty: (k) => { delete props[k]; },
    getKeys: () => Object.keys(props),
  };

  const sandbox = {
    Date: FakeDate,
    console: { log() {}, error: (...a) => logs.push(['ERROR'].concat(a)) },
    PropertiesService: { getScriptProperties: () => store },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => ({
        timeBased: () => ({
          everyMinutes: (n) => ({ create: () => triggers.push({ n, getHandlerFunction: () => fn }) }),
        }),
      }),
    },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => HUB }),
      getScriptTimeZone: () => 'Asia/Bishkek',
    },
    Utilities: {
      getUuid: () => 'abcdef12-3456-7890-abcd-' + String(++uuid).padStart(12, '0'),
      sleep() {},
      formatDate: (d) => d.toISOString().slice(5, 16),
    },
    Logger: { log: (...a) => logs.push(a) },
    GmailApp: {
      aliases: ['info@jolgo.app'],
      getAliases() { return this.aliases; },
      search(q) {
        sandbox.lastQuery = q;
        const after = Number((q.match(/after:(\d+)/) || [0, 0])[1]) * 1000;
        return messages
            .filter((m) => !m.archived && m.date.getTime() > after && (!/is:unread/.test(q) || m.unread))
            .map((m) => ({ msgs: [m] }));
      },
      getMessagesForThreads: (ts) => ts.map((t) => t.msgs),
      getMessageById(id) {
        const m = messages.find((x) => x.id === id);
        if (!m) throw new Error('not found');
        return m;
      },
    },
    UrlFetchApp: {
      fetch(url, params) {
        const method = url.split('/').pop();
        const payload = params.contentType ? JSON.parse(params.payload) : params.payload;
        calls.push({ method, payload });
        let result = true;
        if (method === 'getMe') result = { username: 'erbol_mail_bot' };
        if (method === 'getUpdates') {
          result = queued.filter((u) => u.update_id >= (payload.offset || 0));
          queued = [];
          if (!result.length) clock += (payload.timeout || 0) * 1000;
        }
        if (method === 'sendMessage' || method === 'sendDocument') result = { message_id: 1000 + calls.length };
        return { getContentText: () => JSON.stringify({ ok: true, result }) };
      },
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sandbox);
  vm.runInContext(`
    CONFIG.BOT_TOKEN = '123:TEST';
    CONFIG.INBOXES = ['Jolgo <info@jolgo.app>', 'ops@jolgo.app'];
  `, sandbox);

  return {
    sandbox, props, calls, messages, triggers, logs, replies,
    run: (fn) => sandbox[fn](),
    add: (o) => { const m = new Msg(o); messages.push(m); return m; },
    update: (u) => { u.update_id = nextUpdate++; queued.push(u); },
    say: (text, extra) => env.update({ message: Object.assign({ chat: { id: 42, type: 'private' }, text, message_id: 500 }, extra) }),
    tap: (data, message) => env.update({
      callback_query: { id: 'cb', data, message: Object.assign({ chat: { id: 42 }, message_id: 777 }, message) },
    }),
    sent: (method) => calls.filter((c) => c.method === (method || 'sendMessage')),
    take() { const c = calls.slice(); calls.length = 0; return c; },
  };
}

let env;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const texts = () => env.sent().map((c) => c.payload.text);
const later = (sec) => new Date(clock + sec * 1000);

test('setup creates one trigger and prints a pairing link', () => {
  env.run('setup');
  env.run('setup');
  assert.strictEqual(env.triggers.length, 1);
  assert.strictEqual(env.props.BOT_TOKEN, '123:TEST');
  const link = env.logs.map((l) => l.join(' ')).join('\n');
  assert.ok(link.includes('https://t.me/%s?start=%s') && env.props.PAIR_CODE, link);
  assert.ok(env.calls.some((c) => c.method === 'deleteWebhook'));
});

test('a wrong code or a stranger cannot pair', () => {
  env.say('/start nope');
  env.update({ message: { chat: { id: 99, type: 'private' }, text: '/start' } });
  env.run('tick');
  assert.ok(!env.props.OWNER_CHAT_ID);
  assert.strictEqual(env.sent().length, 0);
});

test('the right code pairs the chat', () => {
  env.say('/start ' + env.props.PAIR_CODE);
  env.run('tick');
  assert.strictEqual(env.props.OWNER_CHAT_ID, '42');
  assert.ok(!env.props.PAIR_CODE);
  assert.ok(texts()[0].includes('Connected'));
  env.take();
});

test('email forwarded from a watched inbox is posted with its inbox, body and attachment', () => {
  env.add({
    id: 'a1', from: 'Heather G <heatherg@aladdincap.com>', to: 'info@jolgo.app', subject: 'Rate con <MC#1355817>',
    body: 'Hi Erbol,\r\n\r\nPlease see the attached rate con & BOL.\r\n\r\nOn Mon, Oct 26, 2026 at 10:00 AM Jerry <jerry@x.com>\r\nwrote:\r\n> old quoted stuff',
    attachments: [{
      getName: () => 'ratecon.pdf', getSize: () => 2048,
      copyBlob: () => ({ getBytes: () => [], setName(n) { this.name = n; return this; } }),
    }],
    date: later(1),
  });
  env.run('tick');
  const [card] = env.sent();
  const t = card.payload.text;
  assert.ok(t.startsWith('📥 <b>Jolgo</b>'), t);
  assert.ok(t.includes('<b>Heather G</b> &lt;heatherg@aladdincap.com&gt;'), t);
  assert.ok(t.includes('<a href="https://mail.google.com/mail/u/erbolllx@gmail.com/#all/a1">Rate con &lt;MC#1355817&gt;</a>'), t);
  assert.ok(t.includes('rate con &amp; BOL'), t);
  assert.ok(!t.includes('old quoted stuff') && !t.includes('wrote:'), t);
  assert.ok(t.includes('📎 1 attachment'), t);
  const kb = card.payload.reply_markup.inline_keyboard;
  assert.deepStrictEqual(kb[0].map((b) => b.callback_data), ['r:a1', 'a:a1', 'f:a1']);
  const [doc] = env.sent('sendDocument');
  assert.strictEqual(doc.payload.document.name, 'ratecon.pdf');
  assert.strictEqual(doc.payload.chat_id, '42');
  assert.ok(JSON.parse(doc.payload.reply_parameters).message_id > 1000, 'attachment threads under the card');
  assert.ok(env.sandbox.lastQuery.includes('-category:promotions -category:social'));
});

test('the same email is not posted twice', () => {
  env.take();
  env.run('tick');
  env.run('tick');
  assert.strictEqual(env.sent().length, 0);
});

test('mail sent straight to the hub is tagged with the hub', () => {
  env.add({ id: 'b2', from: 'jerry@grtplains.com', subject: 'Settlement report', body: 'See below numbers for AAJ COM.', date: later(2) });
  env.run('tick');
  assert.ok(texts()[0].startsWith('📥 <b>erbolllx@gmail.com</b>'), texts()[0]);
  assert.ok(!env.messages.find((m) => m.id === 'b2').rawRead, 'raw headers read for mail addressed to the hub');
  env.take();
});

test('BCC / list mail is matched through the raw Delivered-To header', () => {
  env.add({
    id: 'c3', from: 'dispatch@trucks.com', to: 'drivers@lists.trucks.com', subject: 'Load 4411', body: 'Load assigned to your team.',
    raw: 'Delivered-To: erbolllx@gmail.com\r\nDelivered-To: ops@jolgo.app\r\nFrom: dispatch@trucks.com\r\n\r\nbody', date: later(3),
  });
  env.run('tick');
  assert.ok(texts()[0].startsWith('📥 <b>ops@jolgo.app</b>'), texts()[0]);
  env.take();
});

test('your own sent mail and forwards keep their right shape', () => {
  env.add({ id: 'd4', from: 'Erbol <erbolllx@gmail.com>', to: 'jerry@grtplains.com', subject: 'Re: x', body: 'mine', date: later(4) });
  env.add({
    id: 'd5', from: 'heatherg@aladdincap.com', to: 'info@jolgo.app', subject: 'FW: FW: Request for FTP Credentials',
    body: 'FYI\n\nFrom: Support <support@factorgenie.com>\nSent: Friday\nSubject: FTP\n\nHere are the FTP details you asked for.', date: later(5),
  });
  env.run('tick');
  assert.strictEqual(env.sent().length, 1);
  assert.ok(texts()[0].includes('Here are the FTP details'), 'forwarded content kept: ' + texts()[0]);
  env.take();
});

test('HTML-only mail is turned into readable text', () => {
  env.add({
    id: 'e6', from: 'news@factor.com', subject: 'Hello', body: '',
    html: '<html><head><style>p{}</style></head><body><p>Line&nbsp;one &amp; more</p><div>Line two</div></body></html>', date: later(6),
  });
  env.run('tick');
  assert.ok(texts()[0].includes('Line one &amp; more\nLine two'), texts()[0]);
  env.take();
});

test('Read and Archive buttons act on Gmail and update the keyboard', () => {
  env.tap('r:b2', { reply_markup: { inline_keyboard: [[{ callback_data: 'r:b2' }, { callback_data: 'a:b2' }]] } });
  env.run('tick');
  const b2 = env.messages.find((m) => m.id === 'b2');
  assert.strictEqual(b2.unread, false);
  let edit = env.sent('editMessageReplyMarkup')[0];
  assert.deepStrictEqual(edit.payload.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['a:b2', 'f:b2']);
  assert.strictEqual(env.sent('answerCallbackQuery')[0].payload.text, 'Marked as read');
  env.take();
  env.tap('a:b2', { reply_markup: edit.payload.reply_markup });
  env.run('tick');
  assert.strictEqual(b2.archived, true);
  edit = env.sent('editMessageReplyMarkup')[0];
  assert.deepStrictEqual(edit.payload.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['f:b2']);
  env.take();
});

test('Full text sends the whole body, quotes included', () => {
  env.tap('f:a1');
  env.run('tick');
  assert.ok(texts()[0].includes('old quoted stuff'), texts()[0]);
  env.take();
});

test('Mute sender stops their next emails; /unmute brings them back', () => {
  env.tap('m:a1');
  env.run('tick');
  assert.deepStrictEqual(JSON.parse(env.props.MUTED), ['heatherg@aladdincap.com']);
  env.take();
  env.add({ id: 'f7', from: 'heatherg@aladdincap.com', to: 'info@jolgo.app', subject: 'again', body: 'again again again', date: later(7) });
  env.run('tick');
  assert.strictEqual(env.sent().length, 0);
  env.say('/mute grtplains.com');
  env.say('/unmute heatherg@aladdincap.com');
  env.run('tick');
  assert.deepStrictEqual(JSON.parse(env.props.MUTED), ['grtplains.com']);
  env.add({ id: 'f8', from: 'britta@grtplains.com', subject: 'muted by domain', body: 'should not show up', date: later(8) });
  env.run('tick');
  assert.ok(!texts().some((t) => t.includes('muted by domain')));
  env.say('/unmute grtplains.com');
  env.run('tick');
  env.take();
});

test('reply flow: confirm first, send from the alias, never twice', () => {
  env.say('Thanks, received.', {
    reply_to_message: { entities: [{ type: 'text_link', url: 'https://mail.google.com/mail/u/erbolllx@gmail.com/#all/a1' }] },
  });
  env.run('tick');
  const confirm = env.sent()[0];
  assert.ok(confirm.payload.text.includes('<b>Reply to</b> heatherg@aladdincap.com'), confirm.payload.text);
  assert.ok(confirm.payload.text.includes('<b>From</b> info@jolgo.app'), confirm.payload.text);
  assert.strictEqual(env.replies.length, 0, 'nothing sent before confirming');
  const key = confirm.payload.reply_markup.inline_keyboard[0][0].callback_data;
  env.take();
  env.tap(key);
  env.tap(key);
  env.run('tick');
  assert.strictEqual(env.replies.length, 1);
  assert.strictEqual(JSON.stringify(env.replies[0]), JSON.stringify({ id: 'a1', t: 'Thanks, received.', o: { from: 'info@jolgo.app' }, all: false }));
  assert.strictEqual(env.sent('answerCallbackQuery')[1].payload.text, 'Already sent or expired');
  env.take();
});

test('replying for an inbox that is not a Send-as alias warns and uses the hub', () => {
  env.say('On it', { reply_to_message: { caption_entities: [{ type: 'text_link', url: 'x/#all/c3' }] } });
  env.run('tick');
  const t = texts()[0];
  assert.ok(t.includes('<b>From</b> erbolllx@gmail.com') && t.includes('ops@jolgo.app isn'), t);
  const kb = env.sent()[0].payload.reply_markup.inline_keyboard[0];
  env.take();
  env.tap(kb[2].callback_data);
  env.run('tick');
  assert.strictEqual(env.replies.length, 1, 'cancel sends nothing');
  assert.ok(!Object.keys(env.props).some((k) => k.startsWith('P_')), 'no pending replies left');
  env.take();
});

test('replying to a message with several emails is refused', () => {
  env.say('hm', { reply_to_message: { entities: [{ type: 'text_link', url: 'x/#all/a1' }, { type: 'text_link', url: 'x/#all/c3' }] } });
  env.run('tick');
  assert.ok(texts()[0].includes('Reply to one email'), texts()[0]);
  env.take();
});

test('/unread lists unread mail with open buttons', () => {
  env.say('/unread');
  env.run('tick');
  const msg = env.sent()[0];
  assert.ok(msg.payload.text.includes('Unread'), msg.payload.text);
  const ids = [].concat(...msg.payload.reply_markup.inline_keyboard).map((b) => b.callback_data);
  assert.ok(ids.includes('o:a1') && ids.includes('o:f8'), ids.join());
  assert.ok(!ids.includes('o:b2') && !ids.includes('o:d4'), 'read and own mail left out: ' + ids.join());
  env.take();
  env.tap('o:c3');
  env.run('tick');
  assert.ok(texts()[0].startsWith('📥 <b>ops@jolgo.app</b>'), texts()[0]);
  env.take();
});

test('Gmail forwarding confirmation is turned into a code + button', () => {
  env.add({
    id: 'aa9', from: 'Gmail Team <forwarding-noreply@google.com>',
    subject: '(#123456789) Gmail Forwarding Confirmation - Receive Mail from ops@jolgo.app',
    body: 'ops@jolgo.app has requested to automatically forward mail to your email address erbolllx@gmail.com.\nConfirmation code: 123456789\n\nTo allow ops@jolgo.app to automatically forward mail to your address, please click the link below to confirm the request:\n\nhttps://mail-settings.google.com/mail/vf-%5Babc%5D-xyz\n\nIf you click the link...',
    date: later(9),
  });
  env.run('tick');
  const m = env.sent()[0];
  assert.ok(m.payload.text.includes('from ops@jolgo.app') && m.payload.text.includes('<code>123456789</code>'), m.payload.text);
  assert.strictEqual(m.payload.reply_markup.inline_keyboard[0][0].url, 'https://mail-settings.google.com/mail/vf-%5Babc%5D-xyz');
  env.take();
});

test('/pause stops posts, /resume skips the paused stretch', () => {
  env.say('/pause');
  env.run('tick');
  env.add({ id: 'bb1', from: 'x@y.com', subject: 'during pause', body: 'paused paused paused', date: later(10) });
  env.run('tick');
  assert.ok(!texts().some((t) => t.includes('during pause')));
  env.take();
  env.say('/resume');
  env.run('tick');
  assert.ok(texts()[0].includes('Back on'));
  env.take();
});

test('/status, /inboxes and unknown text answer', () => {
  env.say('/inboxes');
  env.say('/status');
  env.say('hello');
  env.run('tick');
  const [inboxes, status, hint] = texts();
  assert.ok(inboxes.includes('✉️ Jolgo (info@jolgo.app)') && inboxes.includes('📥 ops@jolgo.app'), inboxes);
  assert.ok(status.includes('Inboxes: 2 + hub'), status);
  assert.ok(hint.includes('Reply'), hint);
  env.take();
});

test('a burst of 20 emails is split over two runs without losing any', () => {
  for (let i = 0; i < 20; i++) {
    env.add({ id: 'cc' + (10 + i), from: 'broker' + i + '@loads.com', subject: 'Load ' + i, body: 'Pickup tomorrow morning.', date: later(20 + i) });
  }
  env.run('tick');
  assert.strictEqual(env.sent().length, 15);
  env.take();
  env.run('tick');
  const rest = texts();
  assert.strictEqual(rest.length, 5);
  assert.ok(rest[0].includes('Load 15') && rest[4].includes('Load 19'), rest.join('|'));
  env.take();
  env.run('tick');
  assert.strictEqual(env.sent().length, 0);
});

test('state stays well under the 9 KB property limit', () => {
  for (let i = 0; i < 400; i++) env.sandbox.remember_({ state: JSON.parse(env.props.STATE) }, 'ffffffffffffffff');
  const ctx = { state: JSON.parse(env.props.STATE) };
  for (let i = 0; i < 400; i++) env.sandbox.remember_(ctx, (0x1a0000000000000 + i).toString(16));
  assert.ok(JSON.stringify(ctx.state).length < 7000, JSON.stringify(ctx.state).length);
});

test('no errors were logged', () => {
  const errors = env.logs.filter((l) => l[0] === 'ERROR');
  assert.deepStrictEqual(errors, []);
});

env = makeEnv();
let failed = 0;
for (const t of tests) {
  env.take();
  try {
    t.fn();
    console.log('ok   ' + t.name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + t.name + '\n     ' + e.message);
  }
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
