-- Phase 2 — read-only mirror of Google Calendar.
--
-- planner_calendar_events is a shadow copy, not a cache: phase 4 diffs against
-- it to tell an incoming change from an echo of our own write, so it must
-- record what Google last said rather than what we last rendered.

create table public.planner_sync_state (
  user_id             uuid primary key references auth.users (id) on delete cascade,
  calendar_id         text not null default 'primary',
  -- Google's incremental cursor. Null means the next run is a full resync.
  sync_token          text,
  -- Phase 4's push channel; renewal is driven off the expiry.
  channel_id          text,
  channel_resource_id text,
  channel_expires_at  timestamptz,
  last_incremental_at timestamptz,
  last_full_sync_at   timestamptz,
  consecutive_failures integer not null default 0,
  updated_at          timestamptz not null default now()
);

create trigger planner_sync_state_set_updated_at
  before update on public.planner_sync_state
  for each row execute function public.planner_set_updated_at();

create table public.planner_calendar_events (
  user_id           uuid not null references auth.users (id) on delete cascade,
  gcal_event_id     text not null,
  calendar_id       text not null,
  etag              text,
  summary           text,
  start_at          timestamptz,
  end_at            timestamptz,
  is_all_day        boolean not null default false,
  status            text not null default 'confirmed',
  html_link         text,
  remote_updated_at timestamptz,
  -- True once phase 3 starts creating events from tasks.
  owned_by_app      boolean not null default false,
  raw               jsonb,
  synced_at         timestamptz not null default now(),
  primary key (user_id, gcal_event_id)
);

create index planner_calendar_events_window_idx
  on public.planner_calendar_events (user_id, start_at)
  where status <> 'cancelled';

-- The heartbeat the phase 5 watchdog reads. Written from the first sync
-- onwards so "when did this last work" is answerable before it breaks.
create table public.planner_sync_runs (
  id            bigserial primary key,
  user_id       uuid references auth.users (id) on delete cascade,
  kind          text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  ok            boolean,
  changed_count integer,
  error         text
);

create index planner_sync_runs_recent_idx on public.planner_sync_runs (user_id, started_at desc);

alter table public.planner_sync_state      enable row level security;
alter table public.planner_calendar_events enable row level security;
alter table public.planner_sync_runs       enable row level security;

-- Read-only to the browser; every write goes through the Edge Function.
create policy planner_calendar_events_select on public.planner_calendar_events
  for select to authenticated using ((select auth.uid()) = user_id);
create policy planner_sync_state_select on public.planner_sync_state
  for select to authenticated using ((select auth.uid()) = user_id);
create policy planner_sync_runs_select on public.planner_sync_runs
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.planner_calendar_events from anon, authenticated;
revoke all on public.planner_sync_state      from anon, authenticated;
revoke all on public.planner_sync_runs       from anon, authenticated;

grant select on public.planner_calendar_events to authenticated;
grant select on public.planner_sync_state      to authenticated;
grant select on public.planner_sync_runs       to authenticated;
