# Time-blocking task manager — system design

A personal task manager where every task can be scheduled into Google Calendar,
and changes flow both ways continuously.

**Design goal: it must still be working in six months without anyone touching it.**
That constraint drives almost every decision below. A calendar integration that
works on day one is easy; one that works on day two hundred is a different
problem, and it is mostly about failure recovery, not features.

- Single user (one Google account)
- Our Postgres is the source of truth for tasks; Google Calendar is a two-way mirror for *scheduled* tasks
- Installable PWA — desktop and phone, one codebase

---

## 1. Product loop

The thing the app actually does, so the architecture has something to serve:

1. **Capture** — add a task: title, estimate, due date, priority, project.
2. **See** — a day/week grid showing real calendar busy blocks pulled from Google.
3. **Schedule** — drag an unscheduled task onto a slot. This creates a real Google Calendar event.
4. **Reschedule anywhere** — drag that event in Google Calendar on your phone, and the task's schedule updates in the app. Drag it in the app, and Google updates.
5. **Complete** — checking the task off marks the event done (title prefix + colour change).
6. **Triage** — a Today view: what's scheduled, what's overdue, what's unscheduled and due soon.

Scope boundary for v1: the app **reads** recurring events and external meetings as
read-only busy blocks. It only **writes** single, non-recurring events that it
created itself. Recurring-event write support is a large, separate problem
(exceptions, split series, `recurringEventId` semantics) and is deliberately out.

---

## 2. Stack

| Layer | Choice | Why this one |
|---|---|---|
| Frontend | React + TypeScript + **Vite** | SPA is enough; no SSR needed for a single-user private app. Fast builds. |
| PWA | `vite-plugin-pwa` (Workbox) | Installable, offline shell, home-screen icon on iOS/Android. |
| UI | Tailwind + shadcn/ui | Fast to build, no design system to invent. |
| Calendar grid | FullCalendar (MIT core) | Drag/drop + time grid is weeks of work to build well. Don't. |
| Client data | TanStack Query + `supabase-js` | Caching, retries, optimistic updates. Supabase Realtime pushes DB changes into the open tab. |
| Database | **Supabase Postgres 17** | Already provisioned. RLS, Realtime, cron and functions in one place. |
| App auth | Supabase Auth (Google sign-in) | Just for logging into the app. |
| Calendar auth | **Own OAuth flow**, tokens stored by us | Deliberately *not* Supabase's provider tokens — see §6. |
| Server logic | Supabase Edge Functions (Deno) | Webhook receiver, OAuth callback, sync workers. |
| Scheduling | `pg_cron` + `pg_net` | Postgres calls the Edge Functions on a schedule. No extra infra. |
| Secrets | Supabase Vault | Encrypted refresh token at rest. |
| Hosting | **Netlify** | Static PWA, HTTPS, already connected. |
| Watchdog | **GitHub Actions cron** | Free, and critically — *outside* Supabase. See §5, layer 4. |
| Alerts | Resend (email) + Web Push | Tells you when sync is broken. |

Everything sits in free tiers.

---

## 3. Components

```
  ┌──────────────┐   Realtime    ┌──────────────────────────────┐
  │  PWA         │◀──────────────│  Supabase Postgres           │
  │  (Netlify)   │──── writes ──▶│  tasks · events · sync_state │
  └──────────────┘               │  outbox · sync_runs          │
                                 └──────┬───────────────────────┘
                                        │ pg_cron + pg_net
                                        ▼
                        ┌───────────────────────────────┐
                        │  Edge Functions (Deno)        │
                        │  oauth-callback               │
                        │  calendar-webhook   ◀── Google push
                        │  sync-pull  ─────────▶ Google Calendar API
                        │  outbox-drain ───────▶ Google Calendar API
                        │  reconcile · watchdog-beat    │
                        └───────────────────────────────┘
                                        ▲
                    GitHub Actions cron ─┘  (external liveness check)
```

---

## 4. Data model

Sketch, not final DDL. All timestamps `timestamptz`, stored UTC.

```sql
-- Tasks: our source of truth
tasks (
  id uuid pk, user_id uuid,
  title text, notes text,
  status text,                  -- inbox | scheduled | done | cancelled
  priority smallint,
  project_id uuid,
  estimate_minutes int,
  due_at timestamptz,
  scheduled_start timestamptz,  -- null = unscheduled
  scheduled_end timestamptz,
  gcal_event_id text unique,    -- set when mirrored to Google
  local_updated_at timestamptz, -- bumped only by app-side edits
  deleted_at timestamptz
)

-- Shadow copy of what Google currently believes.
-- Lets us diff without re-fetching, and detect our own echoes.
calendar_events (
  gcal_event_id text pk, calendar_id text,
  etag text,                    -- echo suppression, see §7
  summary text, start_at timestamptz, end_at timestamptz,
  is_all_day bool, status text, -- confirmed | cancelled
  remote_updated_at timestamptz,
  owned_by_app bool,            -- did we create it?
  raw jsonb
)

-- One row per watched calendar. The memory of the sync engine.
sync_state (
  calendar_id text pk,
  sync_token text,              -- Google incremental cursor
  channel_id text, channel_resource_id text,
  channel_expires_at timestamptz,
  last_incremental_at timestamptz,
  last_full_sync_at timestamptz,
  consecutive_failures int
)

-- Outbound writes, queued. Never call Google in the request path.
outbox (
  id bigserial pk, task_id uuid,
  op text,                      -- create | update | delete
  payload jsonb,
  idempotency_key text unique,
  attempts int, next_attempt_at timestamptz,
  last_error text, done_at timestamptz
)

-- Every sync attempt. This table IS the heartbeat.
sync_runs (
  id bigserial pk, kind text,   -- push | poll | reconcile | outbox
  started_at, finished_at timestamptz,
  ok bool, changed_count int, error text
)

conflicts (id, task_id, field, local_value, remote_value, resolved_as, created_at)
```

RLS on everything, `user_id = auth.uid()`. The Edge Functions use the
service role key and are the only thing that touches `outbox` and `sync_state`.

---

## 5. The durability model — why it keeps working

This is the core of the design. **Every layer exists to catch the failure of the
layer above it.** Any single mechanism will eventually fail silently; layered,
they don't.

### Layer 1 — Push (fast path, seconds)

Google `events.watch` posts to our `calendar-webhook` Edge Function when
anything changes.

Two things people get wrong here:

- **The notification has no body.** It carries only `X-Goog-*` headers saying
  "something changed on this resource". You must then call `events.list` with
  your stored `syncToken` to find out what. The webhook is a doorbell, not a letter.
- **Channels expire and never auto-renew.** Google returns an `expiration`
  timestamp from `watch`. We store it in `sync_state.channel_expires_at` and a
  cron renews at **50% of remaining lifetime** — we never hardcode a renewal
  interval, because Google's internal limits are undocumented and have changed.
  Renew early, tolerate overlapping channels (both just trigger a sync; the
  syncToken makes it idempotent).

Push alone is what breaks after a week. Which is why:

### Layer 2 — Incremental poll (safety net, 10 minutes)

`pg_cron` runs `sync-pull` every 10 minutes regardless of webhooks. Same
`syncToken`-based incremental fetch. If a webhook was dropped, the channel
lapsed, or the function cold-started into an error, this quietly catches up.

Handles `410 GONE` — Google expires sync tokens. On 410: clear the token, run a
full list, re-establish. This is normal operation, not an error.

### Layer 3 — Nightly reconcile (drift repair, daily)

Incremental sync trusts our own bookkeeping. Bugs in that bookkeeping produce
**silent divergence** — the worst failure, because everything reports healthy.

Once a night, list a ±30 day window in full, compare against `calendar_events`
and `tasks`, and repair: orphaned events (task deleted, event lingering),
orphaned tasks (`gcal_event_id` pointing at nothing), field drift. Every repair
is logged. A reconcile that repairs a lot is a bug report.

### Layer 4 — External watchdog (liveness, hourly)

**The watchdog must live outside the system it watches.** A cron inside Supabase
cannot report that Supabase is down.

A GitHub Actions job hits a `watchdog-beat` endpoint hourly. It checks the newest
`sync_runs` row and fails loudly — email + push — if there has been no successful
sync in 45 minutes, or if `consecutive_failures` is climbing, or if the endpoint
is unreachable at all.

This closes a specific cascade that kills free-tier projects: sync breaks →
no database activity → **Supabase pauses the project after 7 days of low
activity** → `pg_cron` stops running → nothing can ever recover itself. Normal
operation (a job every 10 min) keeps the project comfortably active, so pausing
is only a risk *after* something else has already broken. The external watchdog
is what turns "dead forever, silently" into "an email within the hour".

| Failing layer | Caught by | Worst-case delay |
|---|---|---|
| Dropped webhook | Poll | 10 min |
| Expired watch channel | Poll + renewal cron | 10 min |
| Invalidated syncToken (410) | Poll's own 410 handler | 10 min |
| Bad bookkeeping / drift | Nightly reconcile | 24 h |
| Edge Function broken | Watchdog | 1 h |
| Supabase down or paused | Watchdog (external) | 1 h |
| Refresh token dead | Token health check + watchdog | 1 h |

---

## 6. Auth — the thing that actually kills these projects

**Set the OAuth consent screen to "In Production" before you write any sync code.**

A project with an external user type and publishing status **"Testing"** gets
refresh tokens that **expire after 7 days**. This is the single most common
reason a personal Google integration "just stopped working" — it runs perfectly
for a week, then dies, and the error (`invalid_grant`) looks like a code bug.

The trigger is the **publishing status**, not verification. An app can be set to
"In Production" *without* going through verification: you get an "unverified app"
warning screen at consent (click through it once) and a cap of 100 users. For one
user that is irrelevant. **No verification review is needed.** Refresh tokens then
last indefinitely, subject only to: revocation, 6 months unused, password change
on Gmail scopes, or too many live tokens.

Consequences for the design:

- Own the OAuth flow. Don't depend on Supabase Auth's `provider_refresh_token` —
  Supabase hands it over once at sign-in and does not refresh provider tokens for
  you, so you'd end up storing it yourself anyway, with less control over
  `access_type=offline` and `prompt=consent`.
- Store the refresh token in **Supabase Vault**, never in a plain column.
- Cache access tokens with their expiry; refresh on demand with a 60s safety margin.
- A **daily token health check** calls a trivial endpoint. On `invalid_grant`,
  mark the connection dead, alert, and show a reconnect banner in the PWA. The
  goal is that a dead token is a 30-second fix you're told about, not a mystery
  you discover weeks later.

Scopes: `calendar.events` (read/write events) and `calendar.readonly` for listing
calendars. Not full `calendar` — no need to create or delete calendars.

---

## 7. Two-way sync correctness

Three problems, three specific mechanisms.

**Echo loops.** We write to Google → Google fires a webhook → we read the change
→ we think it's external → we write back. Forever. *Fix:* Google returns the new
`etag` on every write. Store it in `calendar_events.etag`. When a change arrives,
compare etags; if it matches what we last wrote, it's our own echo — drop it.

**Duplicate creates.** A retry after a timeout creates a second event. *Fix:*
Google's `events.insert` accepts a **client-supplied `id`**. Derive it
deterministically from the task id (base32hex, per Google's format rules). A
retried create returns `409 Conflict` instead of a duplicate — the retry becomes
safe by construction. This is why the outbox has an `idempotency_key`.

**Conflicts.** The task was edited in the app while the event was dragged in
Google, between two syncs. *Fix:* compare `tasks.local_updated_at` against the
event's `updated`; newer wins, **field by field** — a title edit in the app and a
time drag in Google both survive. Every conflict resolution writes a `conflicts`
row, so nothing is ever silently lost.

**Never call Google in the request path.** A user action writes to Postgres and
enqueues an `outbox` row, then returns immediately — the UI updates optimistically
via Realtime. `outbox-drain` pushes to Google with exponential backoff. A Google
outage becomes a delay, not lost work.

Times are stored UTC with a separate IANA timezone on the user. All-day events
are date-only and must never be run through a timezone conversion — that's the
classic off-by-one-day bug.

---

## 8. Setup checklist (order matters)

1. Google Cloud project → enable **Google Calendar API**.
2. OAuth consent screen → External → **Publish to Production**. ← *do this first*
3. OAuth client (Web) → redirect URI = the `oauth-callback` Edge Function URL.
4. Netlify site connected to this repo; note the production domain.
5. Supabase: run migrations, enable `pg_cron` + `pg_net`, store secrets in Vault.
6. Deploy Edge Functions; register the `watch` channel against the webhook URL
   (must be HTTPS with a valid certificate — Supabase Edge Functions satisfy this).
7. Add the GitHub Actions watchdog workflow + repo secrets.
8. Verify: create an event in Google Calendar on your phone, confirm it appears
   in the app within seconds. Then disable the webhook and confirm the 10-minute
   poll still catches it. **Test the fallback, not just the happy path.**

---

## 9. Build order

Each phase is independently useful and independently testable.

| Phase | Deliverable |
|---|---|
| 0 | Schema + RLS + auth. Log in, CRUD tasks. No calendar yet. |
| 1 | OAuth flow, token storage, list calendars. Prove the token survives a week. |
| 2 | **Read-only** sync: Google → app. Calendar grid renders real busy blocks. |
| 3 | Write path: schedule a task → event appears in Google. Outbox + idempotent creates. |
| 4 | Full two-way: webhook, echo suppression, conflict rules. |
| 5 | Durability: reconcile, watchdog, alerting, reconnect UI. |
| 6 | PWA polish: offline shell, install prompt, push notifications. |

Phase 5 is not optional garnish — it's the phase that decides whether this is
still running in six months.

---

## 10. Cost

| | Free tier | Note |
|---|---|---|
| Supabase | Free | Pauses after 7 days of *low* activity; our crons prevent that. Pro ($25/mo) removes the risk entirely if it ever matters. |
| Netlify | Free | Static site. |
| GitHub Actions | Free | Public repo, or well within private-repo minutes. |
| Google Calendar API | Free | ~1M queries/day; we use a few hundred. |
| Resend | Free | 100 emails/day; we send only alerts. |

---

## Sources

- [Google — Using OAuth 2.0 to access Google APIs (refresh token expiration)](https://developers.google.com/identity/protocols/oauth2)
- [Google — Manage app audience (Testing vs In Production, user caps)](https://support.google.com/cloud/answer/15549945?hl=en)
- [Google Calendar API — Push notifications](https://developers.google.com/workspace/calendar/api/guides/push)
- [Supabase — Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
