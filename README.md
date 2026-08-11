# management

A personal time-blocking task manager with continuous two-way Google Calendar sync.

Tasks live in Postgres (source of truth). Scheduling a task creates a real
Google Calendar event; moving that event in Google Calendar updates the task.

**→ [System design](docs/ARCHITECTURE.md)** — stack, data model, sync durability
model, and the Google OAuth setting that decides whether this survives past
week one.

## Status

Phase 0 complete: schema, RLS, auth and task CRUD. No calendar integration yet
— see the build order in the architecture doc.

## Stack

React + Vite PWA on Netlify · Supabase Postgres + Edge Functions + pg_cron ·
Google Calendar API · GitHub Actions as an external watchdog.

## Database layout

The app owns the **`planner`** schema, not `public`. The Supabase project it
runs in already hosts an unrelated task manager in `public` (`tasks`,
`daily_log`, `task_templates`, `domains`, `settings`) that is still in use, so
the two systems are kept in separate namespaces and never collide.

## Setup

```bash
npm install
cp .env.example .env   # fill in the project URL and publishable key
npm run dev
```

### One-time dashboard step

PostgREST only serves schemas it has been told to expose, and `planner` is not
exposed by default. Without this the app gets
`PGRST106 · Invalid schema: planner` on every request:

1. Open **Settings → API** in the Supabase dashboard.
2. Find **Exposed schemas** and add `planner` alongside `public`.
3. Save.

Verify from the shell:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "$VITE_SUPABASE_URL/rest/v1/tasks?select=id&limit=1" \
  -H "apikey: $VITE_SUPABASE_PUBLISHABLE_KEY" \
  -H "Accept-Profile: planner"
```

`401` means the schema is exposed and row-level security is doing its job —
anonymous callers are refused, signed-in ones are not. `406` means step 2 has
not taken effect yet.

### Google sign-in

Enable the Google provider under **Authentication → Providers**, and add the
app's origin to the allowed redirect URLs.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server on :5173 |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run typecheck` | Types only |
| `npm run preview` | Serve the built bundle |
