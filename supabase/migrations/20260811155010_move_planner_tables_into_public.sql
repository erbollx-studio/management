-- ============================================================================
-- Move the phase 0 tables out of `planner` and into `public` under a
-- `planner_` prefix.
--
-- PostgREST only serves schemas on its exposed list, and adding `planner` to
-- that list is a dashboard / Management-API setting that SQL cannot reach --
-- every request against the schema answered PGRST106. Prefixed names in
-- `public` give the same isolation from the pre-existing task manager (which
-- owns the unprefixed `tasks`, `daily_log`, `task_templates`, `domains`,
-- `settings`) without depending on that setting.
--
-- The tables are recreated rather than renamed: a `set schema` move would
-- collide on constraint and index names that `public` already carries, such as
-- tasks_pkey and tasks_user_id_fkey. They were empty, so nothing is lost.
-- Every constraint and index below is explicitly named for the same reason.
-- ============================================================================

drop schema if exists planner cascade;

create or replace function public.planner_set_updated_at()
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
create or replace function public.planner_bump_local_updated_at()
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

create table public.planner_projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null constraint planner_projects_name_len check (length(btrim(name)) between 1 and 120),
  color       text not null default '#3E8CA0' constraint planner_projects_color_hex check (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order  double precision not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index planner_projects_user_idx on public.planner_projects (user_id, sort_order)
  where archived_at is null;

create trigger planner_projects_set_updated_at
  before update on public.planner_projects
  for each row execute function public.planner_set_updated_at();

-- ------------------------------------------------------------------ tasks --

create table public.planner_tasks (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id       uuid references public.planner_projects (id) on delete set null,

  title            text not null constraint planner_tasks_title_len check (length(btrim(title)) between 1 and 500),
  notes            text,
  status           text not null default 'inbox'
                     constraint planner_tasks_status_valid check (status in ('inbox', 'scheduled', 'done', 'cancelled')),
  priority         smallint not null default 0 constraint planner_tasks_priority_range check (priority between 0 and 3),
  estimate_minutes integer constraint planner_tasks_estimate_range check (estimate_minutes > 0 and estimate_minutes <= 1440),

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

  constraint planner_tasks_schedule_ordered
    check (scheduled_start is null or scheduled_end is null or scheduled_end > scheduled_start),
  constraint planner_tasks_schedule_paired
    check ((scheduled_start is null) = (scheduled_end is null)),
  constraint planner_tasks_done_has_timestamp
    check ((status = 'done') = (completed_at is not null))
);

-- One Google event maps to at most one task. Partial so unscheduled tasks,
-- which all carry null, do not collide.
create unique index planner_tasks_gcal_event_idx on public.planner_tasks (gcal_event_id)
  where gcal_event_id is not null;

create index planner_tasks_user_status_idx on public.planner_tasks (user_id, status)          where deleted_at is null;
create index planner_tasks_user_due_idx    on public.planner_tasks (user_id, due_at)          where deleted_at is null and status <> 'done';
create index planner_tasks_user_sched_idx  on public.planner_tasks (user_id, scheduled_start) where deleted_at is null;
create index planner_tasks_project_idx     on public.planner_tasks (project_id)               where deleted_at is null;

create trigger planner_tasks_set_updated_at
  before update on public.planner_tasks
  for each row execute function public.planner_set_updated_at();

create trigger planner_tasks_bump_local_updated_at
  before update on public.planner_tasks
  for each row execute function public.planner_bump_local_updated_at();

-- -------------------------------------------------------------------- RLS --

alter table public.planner_projects enable row level security;
alter table public.planner_tasks    enable row level security;

-- auth.uid() is wrapped in a scalar subquery so the planner evaluates it once
-- per statement rather than once per row.
create policy planner_projects_select on public.planner_projects
  for select to authenticated using ((select auth.uid()) = user_id);
create policy planner_projects_insert on public.planner_projects
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy planner_projects_update on public.planner_projects
  for update to authenticated using ((select auth.uid()) = user_id)
                                with check ((select auth.uid()) = user_id);
create policy planner_projects_delete on public.planner_projects
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy planner_tasks_select on public.planner_tasks
  for select to authenticated using ((select auth.uid()) = user_id);
create policy planner_tasks_insert on public.planner_tasks
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy planner_tasks_update on public.planner_tasks
  for update to authenticated using ((select auth.uid()) = user_id)
                             with check ((select auth.uid()) = user_id);
create policy planner_tasks_delete on public.planner_tasks
  for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.planner_projects to authenticated;
grant select, insert, update, delete on public.planner_tasks    to authenticated;
