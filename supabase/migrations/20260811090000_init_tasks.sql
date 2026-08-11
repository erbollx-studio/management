-- ============================================================================
-- Phase 0 — projects and tasks
--
-- Postgres is the source of truth for tasks (see docs/ARCHITECTURE.md §4).
-- Calendar columns are declared here but stay unused until phase 3, so that
-- the sync work does not have to rewrite the table it depends on.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- helpers --

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- `local_updated_at` is the app-side edit clock. Conflict resolution in phase 4
-- compares it against Google's `updated` field, so it must move only when a
-- user-meaningful field changes -- never on bookkeeping writes such as storing
-- an etag, or every sync would look like a local edit.
create or replace function public.bump_local_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if row(new.title, new.notes, new.status, new.priority, new.project_id,
         new.estimate_minutes, new.due_at, new.scheduled_start, new.scheduled_end)
     is distinct from
     row(old.title, old.notes, old.status, old.priority, old.project_id,
         old.estimate_minutes, old.due_at, old.scheduled_start, old.scheduled_end)
  then
    new.local_updated_at := now();
  end if;
  return new;
end;
$$;

-- --------------------------------------------------------------- projects --

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 120),
  color       text not null default '#3E8CA0' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order  double precision not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index projects_user_idx on public.projects (user_id, sort_order)
  where archived_at is null;

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------------ tasks --

create table public.tasks (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id       uuid references public.projects (id) on delete set null,

  title            text not null check (length(btrim(title)) between 1 and 500),
  notes            text,
  status           text not null default 'inbox'
                     check (status in ('inbox', 'scheduled', 'done', 'cancelled')),
  priority         smallint not null default 0 check (priority between 0 and 3),
  estimate_minutes integer check (estimate_minutes > 0 and estimate_minutes <= 1440),

  due_at           timestamptz,
  scheduled_start  timestamptz,
  scheduled_end    timestamptz,
  completed_at     timestamptz,

  -- reserved for phase 3+; see docs/ARCHITECTURE.md §7
  gcal_event_id    text,
  gcal_etag        text,

  sort_order       double precision not null default 0,
  local_updated_at timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,

  constraint tasks_schedule_ordered
    check (scheduled_start is null or scheduled_end is null or scheduled_end > scheduled_start),
  constraint tasks_schedule_paired
    check ((scheduled_start is null) = (scheduled_end is null)),
  constraint tasks_done_has_timestamp
    check ((status = 'done') = (completed_at is not null))
);

-- One Google event maps to at most one task. Partial so unscheduled tasks,
-- which all carry null, do not collide.
create unique index tasks_gcal_event_idx on public.tasks (gcal_event_id)
  where gcal_event_id is not null;

create index tasks_user_status_idx  on public.tasks (user_id, status)          where deleted_at is null;
create index tasks_user_due_idx     on public.tasks (user_id, due_at)          where deleted_at is null and status <> 'done';
create index tasks_user_sched_idx   on public.tasks (user_id, scheduled_start) where deleted_at is null;
create index tasks_project_idx      on public.tasks (project_id)               where deleted_at is null;

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

create trigger tasks_bump_local_updated_at
  before update on public.tasks
  for each row execute function public.bump_local_updated_at();

-- -------------------------------------------------------------------- RLS --

alter table public.projects enable row level security;
alter table public.tasks    enable row level security;

-- auth.uid() is wrapped in a scalar subquery so the planner evaluates it once
-- per statement rather than once per row.
create policy projects_select on public.projects
  for select to authenticated using ((select auth.uid()) = user_id);
create policy projects_insert on public.projects
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy projects_update on public.projects
  for update to authenticated using ((select auth.uid()) = user_id)
                                with check ((select auth.uid()) = user_id);
create policy projects_delete on public.projects
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy tasks_select on public.tasks
  for select to authenticated using ((select auth.uid()) = user_id);
create policy tasks_insert on public.tasks
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy tasks_update on public.tasks
  for update to authenticated using ((select auth.uid()) = user_id)
                             with check ((select auth.uid()) = user_id);
create policy tasks_delete on public.tasks
  for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.tasks    to authenticated;
