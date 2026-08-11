# management

A personal time-blocking task manager with continuous two-way Google Calendar sync.

Tasks live in Postgres (source of truth). Scheduling a task creates a real
Google Calendar event; moving that event in Google Calendar updates the task.

**→ [System design](docs/ARCHITECTURE.md)** — stack, data model, sync durability
model, and the Google OAuth setting that decides whether this survives past
week one.

## Status

Design phase. No code yet — see the build order in the architecture doc.

## Planned stack

React + Vite PWA on Netlify · Supabase Postgres + Edge Functions + pg_cron ·
Google Calendar API · GitHub Actions as an external watchdog.
