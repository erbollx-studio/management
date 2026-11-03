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
2. 🚚 **Load emails: never**, even when they say "payment". A load email is
   one whose subject has a load or PO number, "rate confirmation", "delivery
   receipt", BOL, POD, tender, pickup, TONU, detention, lumper, or a lane
   like "Las Vegas, NV to Rocklin, CA" / "CA-NV" (`LOAD_SUBJECTS` in `mail.ts`).
3. 💵 **Money emails (🧾 💰) only from allowed senders**, the money list
   (`/senders`). It goes by company domain, so allowing `ecapital.com` covers
   wallet@, reports@ and every other eCapital address. A money email from a
   sender who isn't on the list comes **once**, marked `🆕 new sender`, with
   **✓ Allow** and **✕ Not money**. Until you answer, their next money emails
   wait in the daily list. Tap a name in `/senders` to forget it, and the next
   one asks again.
4. The inbox's own words (`/filter`), unless it's a load email.
5. Everything else: the daily list.

## The tag: 📌 erbol

Put the Gmail label **erbol** on any email, in any connected inbox, and it
comes to the chat within a minute, whatever the templates, filters and 🔕
say. The card starts with `📌 erbol`. The bot makes the label in each inbox
the first time, so it is already in Gmail's label menu; anyone who works in
that inbox (a dispatcher, an accountant) can tag an email for you.

- Tagging a whole conversation sends only its newest message.
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
  once-a-minute run, right after the mail check.
- **🗄 Archive** archives it in Gmail and removes it from the chat.
- **🗑 Delete** removes it from the chat and marks it read in Gmail. The email
  stays in Gmail.
- **🔕 Stop** stops emails like it: from this sender, from everyone at that
  company (not offered for gmail.com and other free mail), or "emails like
  this one" (same sender, same subject apart from numbers and dates).
- **↩ Reply**: tap it (or use Telegram's own Reply on the email) and type.
  The bot shows you the reply first and sends it only after **✅ Send** (or
  **👥 Reply all**). It goes out from the inbox the email came to, in the same
  Gmail conversation. Afterwards the prompt, your typed text and the
  confirmation leave the chat. Text only.

Other bot messages (files, lists, confirmations) have a 🗑 button too, so the
chat stays clean. Emails in the Promotions and Social tabs are skipped.

**Quiet hours** (`/quiet`, 22:00–7:00 at first): cards still arrive, but
without sound or vibration. Only 🔴 urgent insurance rings. `/quiet 23-6`
changes the hours, `/quiet off` turns them off.

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
| `/senders` | The money list: allowed, asked, not money; tap one to forget it |
| `/filter` | Per inbox: templates only, extra words, or all emails |
| `/filter name@company.com erbol, load 4411` | The same in one command; `all` or `templates` switch the mode |
| `/skipped` | Emails that fit no template |
| `/muted` | What you stopped with 🔕; tap one to undo |
| `/check` | Check all inboxes now |
| `/quiet`, `/quiet 23-6`, `/quiet off` | Night hours without sound (🔴 still rings) |
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

No secrets are in this repo. The bot token and the Google tokens are in
Supabase Vault (encrypted storage). The Telegram secret, the schedule key and
the pairing code are made by the migration and kept in `mailbot_config`.

Health check (no private data): `GET …/functions/v1/mail-bot/health`

## Tests

```
deno test mail-bot/test/
```

## Limits

- Gmail and Google Workspace only. Outlook would need a Microsoft sign-in app.
- If Google won't open inside Telegram, copy the `/connect` link into Safari or Chrome.
- Telegram lets bots delete messages for 48 hours. After that, 🗑 shrinks the
  message to "✓" instead.
- Files over 20 MB get a Gmail link instead.
- Replies are plain text.
