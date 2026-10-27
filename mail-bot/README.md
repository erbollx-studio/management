# Mail → Telegram bot

All your work email in one Telegram chat: **@emailsforerbol_bot**.

Each inbox connects with "Sign in with Google". Nothing is forwarded. When an
email arrives in any connected inbox, the bot posts it to Telegram within about
a minute. From Telegram you can:

- **✅ Read**: mark it read in that inbox
- **🗄 Archive**: archive it in that inbox
- **📄 Full text**: see the whole email
- **📎 attachments**: arrive as files under the email
- **🔇 Mute sender**: stop emails from that sender
- **Reply**: use Telegram's Reply on the email and type. The bot shows the reply
  first and sends only when you tap **✅ Send**. It goes out from the inbox the
  email came to.

Promotions and Social tab mail is skipped.

## Commands

| Command | What it does |
|---|---|
| `/connect` | Add an inbox (sign in with Google) |
| `/inboxes` | List connected inboxes |
| `/disconnect name@company.com` | Remove an inbox |
| `/unread` | Newest 10 unread emails; tap a number to open one |
| `/check` | Check all inboxes now |
| `/mute name@company.com` or `/mute company.com` | Stop emails from a sender or a whole domain |
| `/unmute …`, `/muted` | Undo a mute, list mutes |
| `/pause`, `/resume` | Stop or restart notifications |
| `/status` | Is everything working? |

## Where it runs

In the Supabase project **Task Manager** (`vqexlrqphddnnbveppbl`), next to the
calendar sync. It does not touch the planner tables.

- `supabase/functions/mail-bot/index.ts`: the bot (Telegram webhook, Google
  sign-in, once-a-minute check)
- `supabase/functions/mail-bot/mail.ts`: reading emails and building replies
- `supabase/migrations/`: tables (`mailbot_*`), Vault storage for tokens, the cron job

It reuses the Google login app the calendar sync already has
(`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`). That Google Cloud project needs:

1. **Gmail API** turned on.
2. This address in the OAuth client's **Authorized redirect URIs**:
   `https://vqexlrqphddnnbveppbl.supabase.co/functions/v1/mail-bot/callback`

Secrets are not in this repo. The bot token and Google refresh tokens are in
Supabase Vault. The webhook secret, cron token and pairing code are made by the
migration and live in `mailbot_config`.

Health check (no private data): `GET …/functions/v1/mail-bot/health`

## Tests

```
deno test mail-bot/test/
```

## Limits

- Gmail and Google Workspace inboxes only. Outlook / Microsoft 365 would need a
  Microsoft login app as well.
- If Google won't open inside Telegram, copy the `/connect` link into Safari or
  Chrome.
- Attachments over 20 MB get a Gmail link instead of a file.
- Replies are plain text.
