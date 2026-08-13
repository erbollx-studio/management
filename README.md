# management

A personal time-blocking task manager with continuous two-way Google Calendar sync.

Tasks live in Postgres (source of truth). Scheduling a task creates a real
Google Calendar event; moving that event in Google Calendar updates the task.

**→ [System design](docs/ARCHITECTURE.md)** — stack, data model, sync durability
model, and the Google OAuth setting that decides whether this survives past
week one.

**Live:** https://management-erbol.netlify.app

## Status

All phases of the build order are live:

- **0** — schema, RLS, auth, task CRUD
- **1** — OAuth handshake, Vault token custody, calendar listing
- **2** — read-only mirror + week grid
- **3** — write path: drag a task onto the grid, a real event appears in Google
- **4** — two-way: push webhook + 10-minute cron + echo suppression + conflict log
- **5** — nightly reconcile + external GitHub Actions watchdog

The sync durability model from the architecture doc is fully in place: push
(seconds) → poll (10 min) → reconcile (nightly) → watchdog (hourly, external).
The UI follows the Meridian design system from the design handoff.

## Stack

React + Vite PWA on Netlify · Supabase Postgres + Edge Functions + pg_cron ·
Google Calendar API · GitHub Actions as an external watchdog.

## Database layout

Tables are named **`planner_*`** and live in `public`. The Supabase project
already hosts an unrelated task manager that owns the unprefixed `tasks`,
`daily_log`, `task_templates`, `domains` and `settings`, so the prefix is the
namespace — the two systems share a schema without ever colliding.

A dedicated `planner` schema would read better, but PostgREST serves only
schemas on its exposed list, and that list is a dashboard setting rather than
something a migration can set. The prefix needs no configuration to work.

`anon` holds no grant on these tables, so unauthenticated requests are refused
at the permission layer rather than relying on row-level security alone.

## Setup

```bash
npm install
cp .env.example .env   # fill in the project URL and publishable key
npm run dev
```

Check the API is reachable and locked down:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "$VITE_SUPABASE_URL/rest/v1/planner_tasks?select=id&limit=1" \
  -H "apikey: $VITE_SUPABASE_PUBLISHABLE_KEY"
```

`401` is correct — anonymous callers are refused, signed-in ones are not.

## Connecting Google Calendar

The `google-calendar` Edge Function runs the whole handshake — consent, token
exchange, refresh, calendar listing. It needs an OAuth client in Google Cloud
and three secrets in Supabase.

### 1. Google Cloud Console

- APIs & Services → **enable the Google Calendar API**
- OAuth consent screen → External → **Publish to Production**

  Not optional, and worth doing before anything else. A project left in
  *Testing* issues refresh tokens that **expire after 7 days**, and the
  resulting `invalid_grant` reads like a code bug. Publishing without
  verification is fine: you click through an "unverified app" warning once and
  accept a 100-user cap. See [ARCHITECTURE §6](docs/ARCHITECTURE.md).

- Credentials → OAuth client ID → **Web application**
- Authorised redirect URI, exactly:

  ```
  https://<project-ref>.supabase.co/functions/v1/google-calendar/callback
  ```

### 2. Supabase → Edge Functions → Secrets

| Secret | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from the OAuth client |
| `GOOGLE_CLIENT_SECRET` | from the OAuth client |
| `APP_URL` | where to return after consent — `https://management-erbol.netlify.app` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically.

### 3. Connect

Open the app → **Календарь** → connect. Google returns to `APP_URL` with the
outcome in the query string, and the panel reports it.

### Where the token lives

The refresh token goes into **Supabase Vault**, reachable only through two
`SECURITY DEFINER` functions granted to `service_role`. The access token is
cached in `planner_google_tokens`, which has RLS on and no grants at all. The
browser can read connection status from `planner_google_accounts` and nothing
else.

`planner_oauth_states` holds in-flight handshakes with a PKCE verifier; each
state is single-use and expires after 10 minutes.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server on :5173 |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run typecheck` | Types only |
| `npm run preview` | Serve the built bundle |
