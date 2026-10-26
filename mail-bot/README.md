# Mail → Telegram bot

Get the mail from all your work inboxes in one Telegram chat, and handle it from
there: read, archive, see attachments, mute senders, reply.

## How it works

```
info@jolgo.app ─┐
ops@…          ─┼─ auto-forward ─▶ erbolllx@gmail.com (hub) ─▶ Apps Script, every minute ─▶ Telegram
… (10 inboxes) ─┘                                                     ▲
                                              buttons & replies ──────┘
```

Every inbox forwards into one Gmail account (the **hub**). A Google Apps Script
on the hub checks for new mail every minute and posts each email to your
Telegram chat, tagged with the inbox it was sent to.

Why it's built this way:

- **No passwords are stored anywhere.** The script runs inside your Google
  account, and the other inboxes only forward.
- **No server and no bill.** Google runs it for free, and it never sleeps.
- **Works with any provider.** Gmail, Google Workspace, Microsoft 365,
  Yandex, Mail.ru, Zoho and cPanel hosting can all auto-forward. Microsoft 365
  doesn't allow password logins for IMAP anymore, so a bot that logs in to
  each inbox directly wouldn't work there.

Each email arrives as a card:

```
📥 Jolgo
👤 Heather G <heatherg@aladdincap.com>
✉️ FactorGenie System & TMS Integration      ← tap to open in Gmail
🕒 26 Oct, 14:32

Hi Erbol, please find the FTP credentials…

📎 2 attachments                              ← the files follow as Telegram documents
[✅ Read] [🗄 Archive] [📄 Full text]
[🔇 Mute sender] [↗️ Gmail]
```

To answer an email, use Telegram's **Reply** on its card and type your answer.
The bot shows you the reply first, and sends it only after you tap
**✅ Send** or **👥 Reply all**.

| Command | What it does |
|---|---|
| `/unread` | Up to 10 latest unread emails. Tap a number to open one. |
| `/check` | Check mail right now. |
| `/inboxes` | The inboxes it watches, and which ones you can reply from. |
| `/mute x@company.com` or `/mute company.com` | Stop emails from a sender or a whole domain. |
| `/unmute …`, `/muted` | Undo a mute, or list the muted senders. |
| `/pause`, `/resume` | Stop or restart notifications. |
| `/status` | Health check. |

Promotions and Social tab mail is left out by default (`SKIP_CATEGORIES`).

## Setup (about 10 minutes)

### 1. Create the Telegram bot

In Telegram, open **@BotFather**, send `/newbot`, choose a name and a username
ending in `bot`. Copy the token it gives you (`123456789:AA…`).

### 2. Install the script on the hub Gmail

1. Signed in as the hub account, open <https://script.google.com> and click
   **New project**. Name it `Mail bot`.
2. Replace everything in `Code.gs` with the contents of [`Code.gs`](Code.gs).
3. In `CONFIG` at the top:
   - paste the token into `BOT_TOKEN`,
   - list your inboxes in `INBOXES`, for example
     `'Jolgo <info@jolgo.app>', 'ops@company.com'`.
4. Optional, to set the time zone: **Project Settings** → tick
   *Show "appsscript.json"*, then replace that file with
   [`appsscript.json`](appsscript.json).
5. Save, pick **`setup`** in the function dropdown and click **Run**.
6. Google asks for permission. Click **Review permissions**, choose your
   account, then **Advanced** → **Go to Mail bot (unsafe)** → **Allow**. The
   warning appears because the script is your own and Google hasn't reviewed
   it. It only runs inside your account.
7. The execution log prints a link like `https://t.me/your_bot?start=…`. Open
   it on your phone and press **START**. The bot answers *✅ Connected*.

Only the chat that opens that link can use the bot. Messages from anyone else
are ignored. To move the bot to another chat, run `resetPairing`.

### 3. Forward each inbox into the hub

Choose **forward a copy and keep the original** wherever the provider asks.

| Provider | Where | Notes |
|---|---|---|
| **Gmail / Google Workspace** | Settings → See all settings → *Forwarding and POP/IMAP* → *Add a forwarding address* | Google emails a confirmation code to the hub. **The bot shows it to you in Telegram with a Confirm button.** On Workspace, the admin may first need to allow it: Admin console → Apps → Gmail → End User Access → *Automatic forwarding*. |
| **Microsoft 365 / Outlook** | Outlook on the web → Settings → Mail → *Forwarding* → Enable, enter the hub, tick *Keep a copy* | Microsoft 365 blocks forwarding to outside addresses by default (error `550 5.7.520`). The admin turns it on in Microsoft Defender → Policies → Anti-spam → *Outbound policy* → Automatic forwarding → **On**. |
| **Yandex** | Settings → *Mail processing rules* → Create rule → Forward to | Sends a confirmation email, which shows up in Telegram. |
| **Mail.ru** | Settings → *Filters* → Add forwarding | Sends a confirmation email, which shows up in Telegram. |
| **Zoho** | Settings → Mail → *Email Forwarding* | Sends a verification code to the hub. |
| **cPanel / hosting** | Email → *Forwarders* → Add forwarder | No confirmation needed. |

When forwarding works, send a test email to that inbox. It should show up in
Telegram within a minute, tagged with the inbox name.

### 4. Optional: reply from the right address

By default, replies from Telegram go out from the hub. To send from the inbox
the email came to, add that address in the hub's Gmail under Settings →
*Accounts* → **Send mail as**. `/inboxes` marks the ones you can reply from
with ✉️.

## Limits

- New mail shows up within about a minute. Right after you tap a button or
  send a reply, the bot answers within seconds for the next 30 seconds.
- Free Gmail accounts get 90 minutes of script run time per day. Checking
  every minute uses about a third to half of that. If Google ever stops the
  script for "too much computer time", set `CHECK_EVERY_MINUTES: 5` and run
  `setup` again.
- Attachments over 20 MB get a Gmail link instead of a file.
- Replies are plain text.

## Tests

The tests run the whole bot in Node against fake Gmail, Telegram and Apps
Script services:

```
node test/harness.js
```
