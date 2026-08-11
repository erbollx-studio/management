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

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server on :5173 |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run typecheck` | Types only |
| `npm run preview` | Serve the built bundle |
