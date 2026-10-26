/**
 * Mail → Telegram bot (Google Apps Script).
 *
 * Runs on the Gmail account that collects your work mail (the "hub"). Each of
 * your inboxes forwards into the hub; once a minute this script posts every new
 * email to your Telegram chat, tagged with the inbox it was sent to. From
 * Telegram you can mark it read, archive it, read the full text, get the
 * attachments, mute the sender, or reply.
 *
 * Setup is in README.md: paste the bot token below, run `setup`, open the link
 * it prints and press START.
 */

const CONFIG = {
  // Token from @BotFather. Or leave empty and add a Script Property BOT_TOKEN
  // (Project Settings → Script Properties).
  BOT_TOKEN: '',

  // Inboxes that forward into this Gmail. Optional display name:
  // 'Jolgo <info@jolgo.app>'.
  INBOXES: [
  ],

  // Also post mail sent straight to this Gmail address.
  INCLUDE_HUB: true,

  // Gmail tabs to leave out: promotions, social, updates, forums.
  SKIP_CATEGORIES: ['promotions', 'social'],

  // 1, 5, 10, 15 or 30. Free Gmail accounts get 90 min of trigger time a day;
  // if Google ever stops the script for "too much computer time", use 5.
  CHECK_EVERY_MINUTES: 1,

  SEND_ATTACHMENTS: true,
  MAX_ATTACHMENT_MB: 20,
  PREVIEW_CHARS: 1200,
  MAX_EMAILS_PER_RUN: 15,
};

const CHECK_MARGIN_MS = 10 * 60 * 1000;  // re-scan this far back: Gmail indexes new mail with a delay
const SEEN_LIMIT = 300;
const ACTIVE_WINDOW_MS = 30 * 1000;      // after you tap or type, keep answering in seconds for this long
const MAX_RUN_MS = 50 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_NOTICE_MS = 60 * 60 * 1000;

const HELP_ = [
  '<b>Commands</b>',
  '/unread: latest unread emails',
  '/check: check mail right now',
  '/inboxes: the inboxes I watch',
  '/mute name@company.com or company.com: stop emails from a sender or domain',
  '/unmute, /muted',
  '/pause, /resume: stop or restart notifications',
  '/status',
  '',
  'To answer an email, use Telegram\'s Reply on it and type your answer. I show you the reply before it goes out.',
].join('\n');

let TOKEN_ = '';

// ── Entry points ────────────────────────────────────────────────────────────

/** Run once from the editor. Safe to run again after changing CONFIG. */
function setup() {
  const store = PropertiesService.getScriptProperties();
  const token = (CONFIG.BOT_TOKEN || store.getProperty('BOT_TOKEN') || '').trim();
  if (!token) throw new Error('Paste your Telegram bot token into CONFIG.BOT_TOKEN, save, and run setup again.');
  TOKEN_ = token;
  const me = tg_('getMe', {});
  if (!me.ok) throw new Error('Telegram rejected the token: ' + me.description);
  store.setProperty('BOT_TOKEN', token);
  tg_('deleteWebhook', {});  // getUpdates is refused while a webhook is set

  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(CONFIG.CHECK_EVERY_MINUTES).create();

  const hub = Session.getEffectiveUser().getEmail();
  GmailApp.getAliases();  // makes the authorization prompt cover Gmail

  if (store.getProperty('OWNER_CHAT_ID')) {
    Logger.log('Bot @%s is running for %s. Nothing else to do.', me.result.username, hub);
    return;
  }
  const code = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  store.setProperty('PAIR_CODE', code);
  Logger.log('Almost done. Open this link on your phone and press START:\n\nhttps://t.me/%s?start=%s',
      me.result.username, code);
}

/** Runs every minute from the trigger that setup() creates. */
function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const ctx = loadCtx_();
    if (!ctx.token) return;
    const started = Date.now();
    let lastActive = pollTelegram_(ctx, 0) ? Date.now() : 0;
    if (ctx.owner && !ctx.state.paused) {
      try {
        checkMail_(ctx);
      } catch (e) {
        reportError_(ctx, e);
      }
    }
    saveCtx_(ctx);
    // Without this, every tap would wait for the next minute's run.
    while (lastActive && Date.now() - lastActive < ACTIVE_WINDOW_MS && Date.now() - started < MAX_RUN_MS) {
      if (pollTelegram_(ctx, 10)) lastActive = Date.now();
    }
    saveCtx_(ctx);
  } finally {
    lock.releaseLock();
  }
}

/** Forgets the paired Telegram chat, so setup() prints a new pairing link. */
function resetPairing() {
  PropertiesService.getScriptProperties().deleteProperty('OWNER_CHAT_ID');
  setup();
}

// ── Telegram updates ────────────────────────────────────────────────────────

function pollTelegram_(ctx, timeoutSec) {
  const res = tg_('getUpdates', {
    offset: ctx.state.offset || 0,
    timeout: timeoutSec,
    allowed_updates: ['message', 'callback_query'],
  });
  if (!res.ok || !res.result.length) return false;
  // Commit the offset before acting, so a crash can't replay an update (and send a reply twice).
  ctx.state.offset = res.result[res.result.length - 1].update_id + 1;
  saveCtx_(ctx);
  let active = false;
  res.result.forEach((u) => {
    try {
      if (handleUpdate_(ctx, u)) active = true;
    } catch (e) {
      reportError_(ctx, e);
    }
  });
  return active;
}

function handleUpdate_(ctx, u) {
  if (u.callback_query) {
    const q = u.callback_query;
    if (!ctx.owner || !q.message || String(q.message.chat.id) !== ctx.owner) return false;
    handleCallback_(ctx, q);
    return true;
  }
  const m = u.message;
  if (!m || m.chat.type !== 'private') return false;
  const text = (m.text || m.caption || '').trim();
  if (!ctx.owner) return tryPair_(ctx, m, text);
  if (String(m.chat.id) !== ctx.owner) return false;
  if (text.charAt(0) === '/') handleCommand_(ctx, text);
  else if (m.reply_to_message) handleReply_(ctx, m, text);
  else send_(ctx, 'To answer an email, use Telegram\'s Reply on it. /help lists the commands.');
  return true;
}

function tryPair_(ctx, m, text) {
  const match = text.match(/^\/start\s+(\S+)/);
  const code = ctx.store.getProperty('PAIR_CODE');
  if (!match || !code || match[1] !== code) return false;
  ctx.owner = String(m.chat.id);
  ctx.store.setProperty('OWNER_CHAT_ID', ctx.owner);
  ctx.store.deleteProperty('PAIR_CODE');
  ctx.state.lastCheck = Date.now();
  send_(ctx, '✅ Connected. New emails will show up here within a minute. /unread shows what is already waiting.\n\n' + HELP_);
  return true;
}

function handleCommand_(ctx, text) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@\w+$/, '');
  const arg = parts.slice(1).join(' ').trim();
  switch (cmd) {
    case '/unread': return cmdUnread_(ctx, arg);
    case '/check': return cmdCheck_(ctx);
    case '/status': return cmdStatus_(ctx);
    case '/inboxes': return cmdInboxes_(ctx);
    case '/mute': return cmdMute_(ctx, arg, true);
    case '/unmute': return cmdMute_(ctx, arg, false);
    case '/muted':
      return send_(ctx, ctx.muted.length ? '🔇 Muted:\n' + esc_(ctx.muted.join('\n')) : 'Nobody is muted.');
    case '/pause':
      ctx.state.paused = true;
      return send_(ctx, '⏸ Paused. /resume turns emails back on.');
    case '/resume':
      ctx.state.paused = false;
      ctx.state.lastCheck = Date.now();
      return send_(ctx, '▶️ Back on. /unread shows what came in meanwhile.');
    default:
      return send_(ctx, HELP_);
  }
}

function handleCallback_(ctx, q) {
  const data = q.data || '';
  const act = data.charAt(0);
  const arg = data.slice(2);
  let toast = '';
  try {
    switch (act) {
      case 'r':
        GmailApp.getMessageById(arg).markRead();
        refreshKeyboard_(ctx, q, arg, false);
        toast = 'Marked as read';
        break;
      case 'a': {
        const msg = GmailApp.getMessageById(arg);
        msg.markRead();
        msg.getThread().moveToArchive();
        refreshKeyboard_(ctx, q, arg, true);
        toast = 'Archived';
        break;
      }
      case 'f':
        sendFullText_(ctx, arg, q.message.message_id);
        break;
      case 'o': {
        const msg = GmailApp.getMessageById(arg);
        const inboxes = detectInboxes_(ctx, msg, false);
        postEmail_(ctx, msg, inboxes.length ? inboxes : [hubInbox_(ctx)]);
        break;
      }
      case 'm': {
        const email = parseAddress_(GmailApp.getMessageById(arg).getFrom()).email;
        if (ctx.muted.indexOf(email) < 0) ctx.muted.push(email);
        send_(ctx, '🔇 Muted ' + esc_(email) + '. /unmute ' + esc_(email) + ' to undo.');
        toast = 'Muted';
        break;
      }
      case 'y':
      case 'Y':
        toast = sendPendingReply_(ctx, arg, act === 'Y', q.message);
        break;
      case 'n':
        ctx.store.deleteProperty('P_' + arg);
        tg_('editMessageText', { chat_id: ctx.owner, message_id: q.message.message_id, text: '✖ Reply cancelled.' });
        break;
    }
  } catch (e) {
    console.error(e);
    toast = 'Failed: ' + e.message;
  }
  tg_('answerCallbackQuery', { callback_query_id: q.id, text: toast.slice(0, 190) });
}

// ── Mail ────────────────────────────────────────────────────────────────────

/** Posts new mail to Telegram and returns how many emails were posted. */
function checkMail_(ctx) {
  const now = Date.now();
  if (!ctx.state.lastCheck) ctx.state.lastCheck = now;
  const cutoff = ctx.state.lastCheck - CHECK_MARGIN_MS;
  const threads = GmailApp.search('in:inbox after:' + Math.floor(cutoff / 1000) + skipCategories_(), 0, 50);
  if (!threads.length) {
    ctx.state.lastCheck = now;
    return 0;
  }
  const seen = ctx.state.seen || [];
  const fresh = [];
  GmailApp.getMessagesForThreads(threads).forEach((msgs) => {
    msgs.forEach((msg) => {
      if (seen.indexOf(msg.getId()) >= 0 || msg.getDate().getTime() < cutoff) return;
      if (msg.isDraft() || msg.isInTrash()) return;
      fresh.push(msg);
    });
  });
  fresh.sort((a, b) => a.getDate().getTime() - b.getDate().getTime());
  const batch = fresh.slice(0, CONFIG.MAX_EMAILS_PER_RUN);
  let posted = 0;
  batch.forEach((msg) => {
    remember_(ctx, msg.getId());
    try {
      if (processMessage_(ctx, msg)) posted++;
    } catch (e) {
      reportError_(ctx, e);
    }
  });
  // If the batch was capped, resume from the last posted email instead of skipping the rest.
  ctx.state.lastCheck = fresh.length > batch.length ? batch[batch.length - 1].getDate().getTime() : now;
  return posted;
}

function processMessage_(ctx, msg) {
  const from = parseAddress_(msg.getFrom());
  if (hub_(ctx).indexOf(from.email) >= 0) return false;  // mail you sent
  if (from.email === 'forwarding-noreply@google.com') return postForwardingCode_(ctx, msg);
  if (isMuted_(ctx, from.email)) return false;
  const inboxes = detectInboxes_(ctx, msg, false);
  if (!inboxes.length) return false;
  postEmail_(ctx, msg, inboxes);
  return true;
}

/**
 * Works out which of your inboxes an email was sent to. `quick` skips reading
 * the raw headers, which is slow for emails with big attachments.
 */
function detectInboxes_(ctx, msg, quick) {
  const hub = hub_(ctx)[0];
  const watched = inboxes_().filter((ib) => ib.email !== hub);
  const visible = [msg.getTo(), msg.getCc(), msg.getBcc(), msg.getHeader('X-Forwarded-For'),
    msg.getHeader('X-Original-To')].join(', ');
  let hits = watched.filter((ib) => hasAddress_(visible, ib.email));
  if (!hits.length && !quick && watched.length && !hasAddress_(visible, hub)) {
    // BCC, mailing lists and some forwarders only leave a trace in Delivered-To / Received.
    const raw = msg.getRawContent();
    const end = raw.search(/\r?\n\r?\n/);
    const head = (end > 0 ? raw.slice(0, end) : raw.slice(0, 20000))
        .replace(/^(From|Sender|Reply-To|Return-Path):.*(\r?\n[ \t].*)*/gmi, '');
    hits = watched.filter((ib) => hasAddress_(head, ib.email));
  }
  if (!hits.length && includeHub_(ctx)) hits = [hubInbox_(ctx)];
  return hits;
}

function postEmail_(ctx, msg, inboxes) {
  const from = parseAddress_(msg.getFrom());
  const link = gmailLink_(ctx, msg.getId());
  const preview = clip_(readableBody_(msg, true), CONFIG.PREVIEW_CHARS);
  const files = CONFIG.SEND_ATTACHMENTS ? msg.getAttachments({ includeInlineImages: false }) : [];
  const lines = [
    '📥 <b>' + esc_(inboxes.map((ib) => ib.label).join(', ')) + '</b>',
    '👤 <b>' + esc_(from.label) + '</b>' + (from.name ? ' ' + esc_('<' + from.email + '>') : ''),
    // The reply flow reads the Gmail ID back from this link.
    '✉️ <a href="' + esc_(link) + '">' + esc_(clip_(msg.getSubject() || '(no subject)', 300)) + '</a>',
    '🕒 ' + fmtDate_(msg.getDate()),
  ];
  if (preview) lines.push('', esc_(preview));
  if (files.length) lines.push('', '📎 ' + files.length + (files.length === 1 ? ' attachment' : ' attachments'));
  const sent = send_(ctx, lines.join('\n'), emailKeyboard_(msg.getId(), link, msg.isUnread(), false));
  const cardId = sent.ok ? sent.result.message_id : null;
  files.slice(0, 10).forEach((f) => sendFile_(ctx, f, link, cardId));
}

function sendFile_(ctx, file, link, replyTo) {
  const name = file.getName() || 'attachment';
  const size = file.getSize();
  if (size > CONFIG.MAX_ATTACHMENT_MB * 1024 * 1024) {
    return send_(ctx, '📎 ' + esc_(name) + ' is ' + Math.round(size / 1048576) + ' MB, too big for Telegram. ' +
        '<a href="' + esc_(link) + '">Open in Gmail</a>', null, replyTo);
  }
  return tg_('sendDocument', {
    chat_id: ctx.owner,
    document: file.copyBlob().setName(name),
    caption: '📎 <a href="' + esc_(link) + '">' + esc_(name) + '</a>',
    parse_mode: 'HTML',
    reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : null,
  });
}

function emailKeyboard_(id, link, unread, archived) {
  const row = [];
  if (unread && !archived) row.push({ text: '✅ Read', callback_data: 'r:' + id });
  if (!archived) row.push({ text: '🗄 Archive', callback_data: 'a:' + id });
  row.push({ text: '📄 Full text', callback_data: 'f:' + id });
  return {
    inline_keyboard: [row, [
      { text: '🔇 Mute sender', callback_data: 'm:' + id },
      { text: '↗️ Gmail', url: link },
    ]],
  };
}

function refreshKeyboard_(ctx, q, id, archived) {
  const rows = (q.message.reply_markup || {}).inline_keyboard || [];
  const wasArchived = !rows.some((row) => row.some((b) => b.callback_data === 'a:' + id));
  tg_('editMessageReplyMarkup', {
    chat_id: ctx.owner,
    message_id: q.message.message_id,
    reply_markup: emailKeyboard_(id, gmailLink_(ctx, id), false, archived || wasArchived),
  });
}

function sendFullText_(ctx, id, replyTo) {
  const msg = GmailApp.getMessageById(id);
  const text = readableBody_(msg, false) || '(empty email)';
  const size = 3800;
  for (let i = 0; i < text.length && i < size * 4; i += size) {
    send_(ctx, esc_(text.slice(i, i + size)), null, replyTo);
  }
  if (text.length > size * 4) {
    send_(ctx, '…the rest is in <a href="' + esc_(gmailLink_(ctx, id)) + '">Gmail</a>.', null, replyTo);
  }
}

/** Gmail sends a confirmation code to the hub when another Gmail account asks to forward into it. */
function postForwardingCode_(ctx, msg) {
  const subject = msg.getSubject() || '';
  const body = msg.getPlainBody() || '';
  const code = (subject.match(/\(#(\d+)\)/) || body.match(/Confirmation code:\s*(\d+)/i) || [])[1];
  const requester = (subject.match(/from\s+(\S+@\S+)/i) || body.match(/(\S+@\S+)\s+has requested/i) || [])[1];
  const confirm = (body.match(/https:\/\/mail(?:-settings)?\.google\.com\/mail\/vf-[^\s<>"]+/) || [])[0];
  const lines = ['🔑 <b>Gmail forwarding request</b>' + (requester ? ' from ' + esc_(requester) : '')];
  if (code) lines.push('Confirmation code: <code>' + esc_(code) + '</code>');
  lines.push('Enter the code in that account\'s forwarding settings, or tap Confirm.');
  send_(ctx, lines.join('\n'), confirm ? { inline_keyboard: [[{ text: '✅ Confirm', url: confirm }]] } : null);
  return true;
}

// ── Replies ─────────────────────────────────────────────────────────────────

function handleReply_(ctx, m, text) {
  const ref = m.reply_to_message;
  const id = gmailIdFrom_(ref.entities) || gmailIdFrom_(ref.caption_entities);
  if (!id) return send_(ctx, 'Reply to one email\'s message to answer it.');
  if (!text) return send_(ctx, 'Only text replies work for now.');
  const msg = GmailApp.getMessageById(id);
  const to = parseAddress_(msg.getReplyTo() || msg.getFrom()).email;
  const sender = sendAsFor_(ctx, msg);
  const key = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  prunePending_(ctx);
  ctx.store.setProperty('P_' + key, JSON.stringify({ id: id, text: text, from: sender.alias || '', at: Date.now() }));
  const lines = ['↩️ <b>Reply to</b> ' + esc_(to), '<b>From</b> ' + esc_(sender.email)];
  if (sender.note) lines.push('⚠️ ' + esc_(sender.note));
  lines.push('', esc_(text));
  send_(ctx, lines.join('\n'), {
    inline_keyboard: [[
      { text: '✅ Send', callback_data: 'y:' + key },
      { text: '👥 Reply all', callback_data: 'Y:' + key },
      { text: '✖ Cancel', callback_data: 'n:' + key },
    ]],
  }, m.message_id);
}

function sendPendingReply_(ctx, key, all, tgMsg) {
  const raw = ctx.store.getProperty('P_' + key);
  if (!raw) return 'Already sent or expired';
  ctx.store.deleteProperty('P_' + key);  // delete before sending: a retry must never send twice
  const p = JSON.parse(raw);
  const msg = GmailApp.getMessageById(p.id);
  const opts = p.from ? { from: p.from } : {};
  if (all) msg.replyAll(p.text, opts);
  else msg.reply(p.text, opts);
  tg_('editMessageText', {
    chat_id: ctx.owner,
    message_id: tgMsg.message_id,
    text: '✅ Sent' + (all ? ' to everyone on the thread' : '') + '\n\n' + esc_(p.text),
    parse_mode: 'HTML',
  });
  return 'Sent';
}

/** Replies go out from the inbox the email came to, if Gmail is allowed to "Send mail as" it. */
function sendAsFor_(ctx, msg) {
  const hub = hub_(ctx)[0];
  const inbox = detectInboxes_(ctx, msg, false)[0];
  if (!inbox || inbox.email === hub) return { email: hub };
  if (ctx.aliases.indexOf(inbox.email) >= 0) return { email: inbox.email, alias: inbox.email };
  return {
    email: hub,
    note: inbox.email + ' isn\'t set up under "Send mail as" in Gmail, so this goes out from ' + hub + '.',
  };
}

function prunePending_(ctx) {
  const now = Date.now();
  ctx.store.getKeys().forEach((k) => {
    if (k.indexOf('P_') !== 0) return;
    const p = parseJson_(ctx.store.getProperty(k), {});
    if (!p.at || now - p.at > PENDING_TTL_MS) ctx.store.deleteProperty(k);
  });
}

/** The Gmail message ID behind an email card or attachment, or '' if there isn't exactly one. */
function gmailIdFrom_(entities) {
  const ids = [];
  (entities || []).forEach((e) => {
    const m = e.type === 'text_link' && /#all\/([0-9a-f]+)/i.exec(e.url || '');
    if (m && ids.indexOf(m[1]) < 0) ids.push(m[1]);
  });
  return ids.length === 1 ? ids[0] : '';
}

// ── Commands ────────────────────────────────────────────────────────────────

function cmdUnread_(ctx, arg) {
  const limit = Math.min(Math.max(parseInt(arg, 10) || 10, 1), 10);
  const threads = GmailApp.search('in:inbox is:unread' + skipCategories_(), 0, 30);
  const hub = hub_(ctx);
  const items = [];
  GmailApp.getMessagesForThreads(threads).some((msgs) => {
    const unread = msgs.filter((m) => m.isUnread() && hub.indexOf(parseAddress_(m.getFrom()).email) < 0);
    const msg = unread[unread.length - 1];
    if (msg && !isMuted_(ctx, parseAddress_(msg.getFrom()).email)) {
      const inboxes = detectInboxes_(ctx, msg, true);
      if (inboxes.length) items.push({ msg: msg, inboxes: inboxes });
    }
    return items.length >= limit;
  });
  if (!items.length) return send_(ctx, '📭 No unread emails.');
  const lines = ['📬 <b>Unread</b>. Tap a number to open one here.', ''];
  const buttons = [];
  items.forEach((it, i) => {
    const from = parseAddress_(it.msg.getFrom());
    lines.push((i + 1) + '. <a href="' + esc_(gmailLink_(ctx, it.msg.getId())) + '">' +
        esc_(clip_(it.msg.getSubject() || '(no subject)', 80)) + '</a>');
    lines.push('     ' + esc_(from.label) + ' · ' + esc_(it.inboxes[0].label) + ' · ' + fmtDate_(it.msg.getDate()));
    buttons.push({ text: String(i + 1), callback_data: 'o:' + it.msg.getId() });
  });
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(buttons.slice(i, i + 5));
  send_(ctx, lines.join('\n'), { inline_keyboard: rows });
}

function cmdCheck_(ctx) {
  if (ctx.state.paused) return send_(ctx, '⏸ Paused. /resume first.');
  if (!checkMail_(ctx)) send_(ctx, '📭 Nothing new.');
}

function cmdStatus_(ctx) {
  send_(ctx, [
    ctx.state.paused ? '⏸ Paused' : '✅ Running, checking every ' +
        (CONFIG.CHECK_EVERY_MINUTES === 1 ? 'minute' : CONFIG.CHECK_EVERY_MINUTES + ' minutes'),
    'Hub: ' + esc_(hub_(ctx)[0]),
    'Inboxes: ' + inboxes_().length + (CONFIG.INCLUDE_HUB ? ' + hub' : ''),
    'Last check: ' + (ctx.state.lastCheck ? fmtDate_(new Date(ctx.state.lastCheck)) : 'never'),
    'Muted: ' + ctx.muted.length,
  ].join('\n'));
}

function cmdInboxes_(ctx) {
  const hub = hub_(ctx)[0];
  const lines = inboxes_().filter((ib) => ib.email !== hub).map((ib) =>
    (ctx.aliases.indexOf(ib.email) >= 0 ? '✉️ ' : '📥 ') +
    esc_(ib.label === ib.email ? ib.email : ib.label + ' (' + ib.email + ')'));
  if (includeHub_(ctx)) lines.push('✉️ ' + esc_(hubInbox_(ctx).label) + ' (hub)');
  if (!lines.length) return send_(ctx, 'No inboxes yet. Add them to CONFIG.INBOXES in the script.');
  lines.push('', '✉️ replies go out from that address. 📥 replies go out from the hub until you add the address ' +
      'in Gmail → Settings → Accounts → "Send mail as".');
  send_(ctx, lines.join('\n'));
}

function cmdMute_(ctx, arg, on) {
  const entry = arg.toLowerCase().replace(/^@/, '');
  if (!/^([^\s@]+@)?[^\s@]+\.[^\s@]+$/.test(entry)) {
    return send_(ctx, 'Usage: /' + (on ? 'mute' : 'unmute') + ' name@company.com or company.com');
  }
  ctx.muted = ctx.muted.filter((x) => x !== entry);
  if (on) ctx.muted.push(entry);
  send_(ctx, (on ? '🔇 Muted ' : '🔔 Unmuted ') + esc_(entry));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadCtx_() {
  const store = PropertiesService.getScriptProperties();
  const props = store.getProperties();
  TOKEN_ = props.BOT_TOKEN || CONFIG.BOT_TOKEN;
  return {
    store: store,
    token: TOKEN_,
    owner: props.OWNER_CHAT_ID || '',
    state: parseJson_(props.STATE, {}),
    muted: parseJson_(props.MUTED, []),
  };
}

function saveCtx_(ctx) {
  ctx.store.setProperties({ STATE: JSON.stringify(ctx.state), MUTED: JSON.stringify(ctx.muted) });
}

function remember_(ctx, id) {
  const seen = ctx.state.seen || (ctx.state.seen = []);
  seen.push(id);
  if (seen.length > SEEN_LIMIT) seen.splice(0, seen.length - SEEN_LIMIT);
}

/** Your own addresses: the hub first, then its "Send mail as" aliases. */
function hub_(ctx) {
  if (!ctx.hub) {
    ctx.aliases = GmailApp.getAliases().map((a) => a.toLowerCase());
    ctx.hub = [Session.getEffectiveUser().getEmail().toLowerCase()].concat(ctx.aliases);
  }
  return ctx.hub;
}

function inboxes_() {
  return CONFIG.INBOXES.map(parseAddress_);
}

function hubInbox_(ctx) {
  const hub = hub_(ctx)[0];
  return inboxes_().filter((ib) => ib.email === hub)[0] || parseAddress_(hub);
}

function includeHub_(ctx) {
  return CONFIG.INCLUDE_HUB || inboxes_().some((ib) => ib.email === hub_(ctx)[0]);
}

function isMuted_(ctx, email) {
  return ctx.muted.some((m) => (m.indexOf('@') >= 0 ? email === m :
    email.slice(-m.length - 1) === '@' + m || email.slice(-m.length - 1) === '.' + m));
}

function hasAddress_(text, email) {
  const re = new RegExp('(^|[^a-z0-9._%+-])' + email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9.-])', 'i');
  return re.test(text || '');
}

function skipCategories_() {
  return CONFIG.SKIP_CATEGORIES.map((c) => ' -category:' + c).join('');
}

function gmailLink_(ctx, id) {
  return 'https://mail.google.com/mail/u/' + hub_(ctx)[0] + '/#all/' + id;
}

function parseAddress_(s) {
  s = String(s || '').trim();
  const m = s.match(/^(.*?)\s*<([^<>]+)>\s*$/);
  const email = (m ? m[2] : s).trim().toLowerCase();
  const name = m ? m[1].replace(/^["'\s]+|["'\s]+$/g, '') : '';
  return { email: email, name: name, label: name || email };
}

const QUOTE_MARKERS_ = [
  /^[ \t]*On\b[^\n]{0,200}(\n[^\n]{0,200})?\bwrote:[ \t]*$/m,
  /^[^\n]{0,200}(пишет|написал|написала|написал\(а\)):[ \t]*$/m,
  /^[ \t]*-{2,}[ \t]*(Original Message|Исходное сообщение|Пересылаемое сообщение)/mi,
  /^[ \t]*(From|От):[^\n]*\n[ \t]*(Sent|Date|Отправлено|Дата):/mi,
  /^[ \t]*_{20,}[ \t]*$/m,
];

/** Plain-text body; with `stripQuotes`, the quoted earlier messages are cut off (except in forwards). */
function readableBody_(msg, stripQuotes) {
  let t = msg.getPlainBody();
  if (!t || !t.trim()) t = htmlToText_(msg.getBody() || '');
  t = t.replace(/\r\n?/g, '\n')
      .replace(/<(?:https?:|mailto:)[^>\s]*>/gi, '')  // "text <link>" left over from HTML mail
      .replace(/\[image:[^\]]*\]/gi, '')
      .replace(/[ \t ]+\n/g, '\n');
  if (stripQuotes && !/^\s*(fw|fwd)\s*:/i.test(msg.getSubject() || '')) t = stripQuoted_(t);
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

function stripQuoted_(text) {
  let cut = text.length;
  QUOTE_MARKERS_.forEach((re) => {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  });
  const head = text.slice(0, cut).replace(/^>.*$/gm, '').trim();
  return head.length >= 20 ? head : text;
}

function htmlToText_(html) {
  return decodeEntities_(html
      .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ''));
}

function decodeEntities_(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, '\'')
      .replace(/&#(\d+);/g, (m, n) => codePoint_(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (m, n) => codePoint_(parseInt(n, 16)))
      .replace(/&amp;/g, '&');
}

function codePoint_(n) {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

function clip_(s, n) {
  return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + ' …' : s;
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'd MMM, HH:mm');
}

function parseJson_(s, fallback) {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch (e) {
    return fallback;
  }
}

function reportError_(ctx, e) {
  console.error(e && e.stack ? e.stack : e);
  const now = Date.now();
  if (!ctx.owner || now - (ctx.state.lastErrorAt || 0) < ERROR_NOTICE_MS) return;
  ctx.state.lastErrorAt = now;
  send_(ctx, '⚠️ Mail bot error: ' + esc_(String(e && e.message ? e.message : e).slice(0, 500)));
}

function send_(ctx, text, markup, replyTo) {
  const payload = {
    chat_id: ctx.owner,
    text: text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  };
  if (markup) payload.reply_markup = markup;
  if (replyTo) payload.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  let res = tg_('sendMessage', payload);
  if (!res.ok && /parse entities/i.test(res.description || '')) {
    payload.text = decodeEntities_(text.replace(/<[^>]+>/g, ''));
    delete payload.parse_mode;
    res = tg_('sendMessage', payload);
  }
  if (!res.ok) console.error('sendMessage failed: ' + res.description);
  return res;
}

/** Calls the Telegram Bot API. Payloads containing a Blob go out as multipart. */
function tg_(method, payload) {
  const multipart = Object.keys(payload).some((k) => payload[k] && typeof payload[k].getBytes === 'function');
  const params = { method: 'post', muteHttpExceptions: true };
  if (multipart) {
    const form = {};
    Object.keys(payload).forEach((k) => {
      const v = payload[k];
      if (v === null || v === undefined) return;
      form[k] = typeof v.getBytes === 'function' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    });
    params.payload = form;
  } else {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(payload);
  }
  const url = 'https://api.telegram.org/bot' + TOKEN_ + '/' + method;
  for (let attempt = 0; ; attempt++) {
    let body;
    try {
      body = JSON.parse(UrlFetchApp.fetch(url, params).getContentText());
    } catch (e) {
      if (attempt >= 2) return { ok: false, description: String(e) };
      Utilities.sleep(1000);
      continue;
    }
    if (body.error_code === 429 && attempt < 2) {
      Utilities.sleep(Math.min((body.parameters && body.parameters.retry_after) || 1, 10) * 1000);
      continue;
    }
    return body;
  }
}
