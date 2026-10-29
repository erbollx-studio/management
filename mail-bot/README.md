# Mail → Telegram bot

All your work email in one Telegram chat: **@emailsforerbol_bot**.

Each inbox connects with "Sign in with Google". Nothing is forwarded. When an
email arrives in any connected inbox, the bot posts it to Telegram within about
a minute.

## What an email looks like

One line, no noise:

```
Heather G → info@dancargologisticsinc.com
[▾ More] [🗑 Delete] [🔕 Stop]
```

- **▾ More** opens the email in the same message: subject, time, the filter
  words that matched, and the text. **▴ Less** folds it back.
- **📄 Full text** shows the whole text (long emails are cut; the rest is in Gmail).
- **📎 N** sends the email's files. Files never come on their own.
- **🗄 Archive** archives it in Gmail and removes it from the chat.
- **🗑 Delete** removes it from the chat and marks it read in Gmail. The email
  stays in Gmail.
- **🔕 Stop** stops emails like it: from this sender, from everyone at that
  company (not offered for gmail.com and other free mail), or "emails like
  this one" (same sender, same subject apart from numbers and dates).
- **Reply**: use Telegram's Reply on the email and type. The bot shows you the
  reply first and sends it only after **✅ Send**. It goes out from the inbox
  the email came to. Afterwards your typed text and the confirmation leave the
  chat.

Other bot messages (files, lists, confirmations) have a 🗑 button too, so the
chat stays clean. Emails in the Promotions and Social tabs are skipped.

## Filters by words

Any inbox can be limited to emails that contain certain words.

- **Commas** mean "any rule": `payment, erbol`
- **Plus** means "all words": `payment + insurance`
- Words are searched everywhere: subject, sender, the whole text and file
  names. Case doesn't matter, and `payment` also finds `payments`.
- **Similar words count too.** `payment` also finds invoice, paid, remittance,
  «оплата», «счёт»; `insurance` also finds premium, COI, «страховка». The lists
  are `FAMILIES` in `mail.ts`.
- Held-back emails aren't lost: the bot sends a list of them every day at
  20:00 (Bishkek), and `/skipped` shows it any time.

An inbox without words gets all its emails.

## Commands

| Command | What it does |
|---|---|
| `/connect` | Add an inbox (sign in with Google) |
| `/inboxes` | Connected inboxes and their filters |
| `/disconnect name@company.com` | Remove an inbox |
| `/unread` | Newest 10 unread emails; tap a number to open one |
| `/filter` | Filter by words: tap an inbox, type the words |
| `/filter name@company.com payment, erbol` | The same in one command; `all` removes the filter |
| `/skipped` | Emails the filters held back |
| `/muted` | What you stopped with 🔕; tap one to undo |
| `/check` | Check all inboxes now |
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
