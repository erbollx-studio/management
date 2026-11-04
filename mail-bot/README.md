# Mail → Telegram bot

All your work email in one Telegram chat: **@emailsforerbol_bot**.

Each inbox connects with "Sign in with Google". Nothing is forwarded. When an
email arrives in any connected inbox, the bot posts it to Telegram within about
a minute.

## Templates

Every email is sorted into a template, first match wins:

| Template | When |
|---|---|
| 🔴 **Insurance · URGENT** | an insurance word and an urgent word (past due, final notice, cancellation, non-payment, lapse…) |
| 💰 **Insurance payment** | a money word and an insurance word |
| 🧾 **Invoice / payment** | a money word |
| ⭐ **Your people** | the sender is on `/people`, whatever the words |

The word lists are `MONEY_WORDS`, `INSURANCE_WORDS` and `URGENT_WORDS` in
`mail.ts`; `/templates` shows them in Telegram.

Words count only in the subject, the sender, file names and the first lines
of the newest message. Old replies, signatures ("Need factoring?"), short
contact lines ("INVOICES / BILLING: ap@broker.com"), footers and phrases like
"privacy policy" don't count. Broker rate confirmations and load offers carry
payment and insurance words in all of those places, so searching the whole
email sent nearly every one of them to the chat.

## What comes to the chat

1. 📌 **Tagged** emails, 🔴 **urgent insurance** and ⭐ **your people**: always.
   **New replies in a conversation you starred (☆ in Gmail) or tagged** too,
   marked `⭐ Starred · reply` or `📌 erbol · reply`, even about a load and
   whatever the templates say (🔕 still stops it). They get the "⏳ No reply
   yet" check. Gmail puts a star or label only on the emails you marked, not
   on later replies, so the bot looks at the whole conversation. Unstar and
   untag it in Gmail to stop. (On 3 Nov two replies in a tagged T-Mobile
   conversation went to the daily list; that can't happen now.)
2. 🚚 **Load emails: never**, even when they say "payment". A load email is
   one whose subject has a load or PO number, "rate confirmation", "delivery
   receipt", BOL, POD, tender, pickup, TONU, detention, lumper, a PRO #, or a
   lane like "Las Vegas, NV to Rocklin, CA" / "EASTVALE, CA > PEDRICKTOWN, NJ" /
   "CA-NV" (`LOAD_SUBJECTS` in `mail.ts`).
3. 💵 **Money emails (🧾 💰) only from allowed senders**, the money list
   (`/senders`). It goes by company domain, so allowing `ecapital.com` covers
   wallet@, reports@ and every other eCapital address. A money email from a
   sender who isn't on the list comes **once**, marked `🆕 new sender`, with
   **✓ Allow** and **✕ Not money**. Until you answer, their next money emails
   wait in the daily list. Tap a name in `/senders` to forget it, and the next
   one asks again.

   **✕ Not money learns two things.** The sender's company: their money
   emails go to the daily list. And the type of email: its subject without
   numbers, dates, month and day names, Re: and Fwd: ("Your weekly fuel
   savings report #45" → `your weekly fuel savings report ##`). Money emails
   with that subject from **anyone** go to the daily list too, without the
   🆕 question. The toast says what it learned: `✕ Not money: nicusa.com, and
   emails like "Your weekly fuel savings report #45" from anyone`.
   - Only a clear subject is learned: it needs two words of its own besides
     money words and plain ones like "your", "invoice", "report", "weekly",
     "account" (`learnedType` in `mail.ts`). "Invoice 4411", "Payment
     received", "Download your statement", "Remittance advice from eCapital"
     or "Final notice: policy #A-4411 past due" are never learned: real money
     from anyone looks like that. Single words like "invoice" are never learned.
   - A learned type never stops 🔴 urgent insurance, ⭐ your people, 📌 tagged
     or ⭐ starred conversations, senders you allowed, an email with the
     inbox's own `/filter` words, or an inbox set to all emails. It only moves
     money emails to the daily list; it never deletes or hides one.
   - `/senders` lists the learned types; tap one to forget it. They are rows
     in `mailbot_senders` with entry `subject:` + the subject and status `denied`.
4. The inbox's own words (`/filter`), unless it's a load email.
5. Everything else: the daily list.

## The tag: 📌 erbol

Put the Gmail label **erbol** on any email, in any connected inbox, and it
comes to the chat within a minute, whatever the templates, filters and 🔕
say. The card starts with `📌 erbol`. The bot makes the label in each inbox
the first time, so it is already in Gmail's label menu; anyone who works in
that inbox (a dispatcher, an accountant) can tag an email for you.

- Tagging a whole conversation sends only its newest message.
- **New replies in a tagged conversation come too**, marked `📌 erbol · reply`,
  with the "⏳ No reply yet" check. A Gmail ☆ star does the same for replies
  (`⭐ Starred · reply`), but the starred email itself doesn't come: you're
  already looking at it. To stop: remove the label or star in Gmail, or 🔕.
- A Gmail filter that puts the label on (for example "from: my accountant →
  label erbol") works too: those emails arrive tagged and come straight here.
- Each email comes once per tag. Spam and the bin are left out.
- A different name: set `tag_label` in `mailbot_config`.

Emails that fit no template go to the daily list, not the chat. Per inbox,
`/filter` can add extra words that also let emails through, or switch the inbox
to all emails.

## What an email looks like

```
🔴 Insurance payment · URGENT
From: Anna Lee · anna@truckinsure.com
To: Dan Cargo · info@dancargologisticsinc.com
Subject: Final notice: policy #A-4411 past due
Your premium of $1,850 was due Oct 30. Coverage will be cancelled on …
[▾ More] [↩ Reply] [⏰] [🗑] [🔕]
```

The subject links to the email in Gmail. The inbox name comes from Gmail.

- **▾ More** opens the rest in the same message: the time, the words that
  chose the template, and more of the text. **▴ Less** folds it back.
- **📄 Full text** shows the whole text (long emails are cut; the rest is in Gmail).
- **📎 N** sends the email's files. Files never come on their own.
- **⏰** brings it back later: in 1 hour, tonight at 19:00 (offered before
  18:00) or tomorrow at 9:00. The card leaves the chat and comes back marked
  `⏰ Reminder`. Reminders live in `mailbot_reminders` and are sent by the
  once-a-minute run, right after the mail check. ⏰ also cancels the
  "⏳ No reply yet" check for that email.
- **🗄 Archive** archives it in Gmail and removes it from the chat.
- **🗑 Delete** removes it from the chat and marks it read in Gmail. The email
  stays in Gmail.
- **🔕 Stop** stops emails like it: from this sender, from everyone at that
  company (not offered for gmail.com and other free mail), or "emails like
  this one" (same sender, same subject apart from numbers and dates).
- **↩ Reply**: tap it (or use Telegram's own Reply on the email) and type.
  The bot shows you the reply first and sends it only after **✅ Send** (or
  **👥 Reply all**); **✨ Polish** can rewrite it first (see below). It goes
  out from the inbox the email came to, in the same Gmail conversation.
  Afterwards the prompt, your typed text and the confirmation leave the chat.
  Text only.

Other bot messages (files, lists, confirmations) have a 🗑 button too, so the
chat stays clean. Emails in the Promotions and Social tabs are skipped.

**📅 Deadlines.** When an email in the chat has a due date, the card shows it:
`📅 Due Tue 10 Nov (in 7 days)`, with **📅 Add to Calendar** and **✕ Wrong
date**. The card comes back marked `📅 Reminder` 3 days before and on the day,
at 9:00 (Bishkek); there **✓ Done** stops the rest. A due date is a date after
a due word in the same sentence (due, deadline, expires, cancelled, renewal,
lapse…) or right after "by / before / until", in the subject or the newest
message: "cancelled on Nov 10", "Due Date: 11/30/2026", "send it by 11/7".
Past dates ("was due Oct 30"), "due to…", and dates more than a year away
don't count. Numbers are read the US way: 11/7 is 7 November. Only emails
that come to the chat are read for dates (`findDeadline` in `mail.ts`).
✕ Wrong date and ✓ Done stop the dates for the whole conversation (a row
with note `off` in `mailbot_reminders`).

**⏳ Nobody answered.** For a ⭐ or 📌 email, the bot checks back after 4
working hours (8:00–20:00 Bishkek, every day). If nobody in that inbox sent a
reply in the Gmail conversation, and the email is still in the inbox, the card
comes back once, marked `⏳ No reply yet`, with its usual buttons. A reply from
the chat (↩ Reply) or from Gmail itself counts, whoever in the company sent it.
No check for noreply@, notifications@ and similar senders, or for your own
emails. 🗄 Archive and ⏰ cancel the check; 🗑 doesn't (it only clears the
chat). When several come back at once, only the first one rings.

**Quiet hours** (`/quiet`, 22:00–7:00 at first): cards still arrive, but
without sound or vibration. Only 🔴 urgent insurance rings. `/quiet 23-6`
changes the hours, `/quiet off` turns them off.

## ✍️ New email and ✨ Polish

**✍️ New email.** Send `/new`. The bot asks which inbox sends it (one button
per inbox), then who it's to (one or more addresses, with commas), the
subject and the text. Answer each question with Telegram's Reply (the bot
opens it for you). Then you see the email: From, To, Subject and the text,
with **✨ Polish**, **✅ Send** and **✕ Cancel**. ✅ Send sends it from that
inbox as plain text. Afterwards the questions and your answers leave the
chat, and a short `✅ Sent from info@…` stays, with 🗑. A typo in an address
is caught: the bot asks again. A new `/new` drops a half-written one. Drafts
live in `mailbot_drafts` and are dropped after a day.

**✨ Polish** is on a new email and on a reply (next to ✅ Send). It rewrites
your text with AI so it is clear, polite, professional and short, in the same
language, with the same names, numbers, dates and load numbers. You see the
new text first, with **✅ Send**, **↩ Use mine** (back to your own text) and
**✕ Cancel**. Nothing is sent until you tap ✅ Send.

- **Numbers are checked.** AI can change a number by mistake, so the bot
  compares the numbers, amounts, dates, times and phones in your text and in
  the new one. If any differ, the preview says so above the buttons:
  `⚠️ Check these: $1,850 → $1,580`. "$1,850", "1850" and "1,850.00" count as
  the same amount, "11/13" and "Nov 13" as the same date (`numbersChanged` in
  `mail.ts`).
- **The AI** is the free model `openai/gpt-oss-120b` on **Groq**. If Groq
  doesn't answer (20 seconds), is busy or down, the bot tries the same model on
  **Cloudflare Workers AI**, if you set it up. If neither works, a message
  says why and your text stays as it was.
- **Keys.** Make a free key at [console.groq.com](https://console.groq.com)
  (no card) and send `/aikey groq <key>`. Backup, if you want one:
  `/aikey cloudflare <account_id> <token>` (a Workers AI token from the
  Cloudflare dashboard). The bot deletes your message with the key right away
  and keeps the key in Supabase Vault. `/aikey` shows which keys are set,
  never the keys.
- **When Groq retires the model**, Polish says "the model was retired". Put
  the new name in `mailbot_config`:
  `insert into mailbot_config (key, value) values ('ai_model', '<new model>')
  on conflict (key) do update set value = excluded.value;`
  (`ai_model_cloudflare` does the same for the backup.)

## Extra words per inbox

On top of the templates, an inbox can let through emails with its own words.

- **Commas** mean "any rule": `erbol, load 4411`
- **Plus** means "all words": `broker + rate`
- Words are searched where the templates look: subject, sender, file names
  and the first lines. Case doesn't matter, and `payment` also finds `payments`.
- **Similar words count too.** `payment` also finds invoice, paid, remittance,
  «оплата», «счёт». The lists are `FAMILIES` in `mail.ts`.
- Held-back emails aren't lost: the bot sends a list of them every day at
  20:00 (Bishkek), and `/skipped` shows it any time.

## Commands

| Command | What it does |
|---|---|
| `/connect` | Add an inbox (sign in with Google) |
| `/inboxes` | Connected inboxes and their filters |
| `/disconnect name@company.com` | Remove an inbox |
| `/unread` | Newest 10 unread emails; tap a number to open one |
| `/templates` | The templates and their words |
| `/people` | Your ⭐ people; tap one to remove |
| `/people name@company.com Anna Lee, insurance agent` | Add a person (or `company.com` for everyone there) |
| `/senders` | The money list: allowed, asked, not money, and the types ✕ Not money learned; tap one to forget it |
| `/filter` | Per inbox: templates only, extra words, or all emails |
| `/filter name@company.com erbol, load 4411` | The same in one command; `all` or `templates` switch the mode |
| `/skipped` | Emails that fit no template |
| `/muted` | What you stopped with 🔕; tap one to undo |
| `/check` | Check all inboxes now |
| `/quiet`, `/quiet 23-6`, `/quiet off` | Night hours without sound (🔴 still rings) |
| `/new` | Write a new email from one of your inboxes |
| `/aikey` | Which AI keys for ✨ Polish are set |
| `/aikey groq <key>`, `/aikey cloudflare <account_id> <token>` | Save an AI key (your message is deleted at once) |
| `/pause`, `/resume` | Stop or restart notifications |
| `/status` | Is everything working |

## Where it runs

In the Supabase project **Task Manager** (`vqexlrqphddnnbveppbl`), next to the
calendar sync. It doesn't touch the planner tables.

- `supabase/functions/mail-bot/index.ts`: the bot (Telegram webhook, Google
  sign-in, the once-a-minute check, the daily list)
- `supabase/functions/mail-bot/mail.ts`: reading emails, filters, mutes,
  cards and replies
- `supabase/migrations/`: the `mailbot_*` tables, token storage in Vault, the
  scheduled jobs

It uses the Google sign-in app the calendar sync already has
(`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`). That Google Cloud project needs:

1. The **Gmail API** turned on.
2. This address in the OAuth client's **Authorized redirect URIs**:
   `https://vqexlrqphddnnbveppbl.supabase.co/functions/v1/mail-bot/callback`

No secrets are in this repo. The bot token, the Google tokens and the AI keys
are in Supabase Vault (encrypted storage). The Telegram secret, the schedule key and
the pairing code are made by the migration and kept in `mailbot_config`.

Health check (no private data): `GET …/functions/v1/mail-bot/health`

## Tests

```
deno test mail-bot/test/
```

## Never losing an email

- An email is marked as handled only after it reached the chat (or the daily
  list). If Telegram or Gmail fails, the bot keeps its place in Gmail and tries
  that email again the next minute.
- One check runs at a time (the `run_lock` row in `mailbot_config`). If a check
  is still busy, the next minute's check waits its turn.
- Telegram and Gmail calls give up after 20 to 30 seconds, and a check stops
  taking new emails after 40 seconds; the rest come next minute.
- Why: on 3 Nov 2026 Telegram hung for two minutes. The next check stepped past
  an email the stuck check was holding, then the stuck check failed, and the
  email never came. A retry can now, at worst, send an email twice; it can't
  drop one.

## Limits

- Gmail and Google Workspace only. Outlook would need a Microsoft sign-in app.
- If Google won't open inside Telegram, copy the `/connect` link into Safari or Chrome.
- Telegram lets bots delete messages for 48 hours. After that, 🗑 shrinks the
  message to "✓" instead.
- Files over 20 MB get a Gmail link instead.
- Replies and new emails are plain text, without files.
