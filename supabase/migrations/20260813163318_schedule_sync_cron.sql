-- Phase 4/5 — the clock that keeps everything alive without a browser open.
-- pg_cron fires inside Postgres; pg_net makes the async HTTP call out to the
-- Edge Function. The bearer token is read from planner_internal_config at
-- execution time (postgres bypasses RLS), so rotating it needs no reschedule.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Layer 2: incremental poll + channel renewal + outbox retry, every 10 min.
select cron.schedule(
  'planner-tick',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://vqexlrqphddnnbveppbl.supabase.co/functions/v1/google-calendar/cron',
    body := '{"job":"tick"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select value from public.planner_internal_config where key = 'cron_token')
    ),
    timeout_milliseconds := 55000
  );
  $$
);

-- Layer 3: nightly full resync + drift repair, 02:30 UTC.
select cron.schedule(
  'planner-reconcile',
  '30 2 * * *',
  $$
  select net.http_post(
    url := 'https://vqexlrqphddnnbveppbl.supabase.co/functions/v1/google-calendar/cron',
    body := '{"job":"reconcile"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select value from public.planner_internal_config where key = 'cron_token')
    ),
    timeout_milliseconds := 120000
  );
  $$
);
