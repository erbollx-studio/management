-- Phase 4 — two-way sync plumbing: internal auth for cron, webhook channel
-- state, conflict log, and the remote-apply path with echo suppression.

-- Internal secrets that never touch Edge Function env: the cron job reads the
-- token here (as postgres), the function compares against the same row (as
-- service_role). No grants: unreachable through PostgREST entirely.
create table public.planner_internal_config (
  key   text primary key,
  value text not null
);
alter table public.planner_internal_config enable row level security;
revoke all on public.planner_internal_config from anon, authenticated;

insert into public.planner_internal_config (key, value)
values ('cron_token', encode(extensions.gen_random_bytes(32), 'hex'));

-- Webhook channel bookkeeping.
alter table public.planner_sync_state add column if not exists channel_token text;

-- Every conflict resolution leaves a row: nothing is ever silently lost.
create table public.planner_conflicts (
  id           bigserial primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  task_id      uuid,
  field        text not null,
  local_value  text,
  remote_value text,
  resolved_as  text not null,
  created_at   timestamptz not null default now()
);
alter table public.planner_conflicts enable row level security;
create policy planner_conflicts_select on public.planner_conflicts
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.planner_conflicts from anon, authenticated;
grant select on public.planner_conflicts to authenticated;

-- ------------------------------------------------ trigger echo suppression --

-- Remote-apply writes set this transaction-local flag so a change arriving
-- FROM Google does not enqueue a push BACK to Google. Both triggers honour it.
create or replace function public.planner_enqueue_task_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_should_exist boolean;
  v_op text;
begin
  if coalesce(current_setting('planner.skip_enqueue', true), '') = 'on' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if row(new.title, new.notes, new.status, new.scheduled_start, new.scheduled_end, new.deleted_at)
       is not distinct from
       row(old.title, old.notes, old.status, old.scheduled_start, old.scheduled_end, old.deleted_at)
    then
      return new;
    end if;
  end if;

  v_should_exist := new.deleted_at is null
                and new.status <> 'cancelled'
                and new.scheduled_start is not null;

  if v_should_exist and new.gcal_event_id is null then
    v_op := 'create';
  elsif v_should_exist and new.gcal_event_id is not null then
    v_op := 'update';
  elsif not v_should_exist and new.gcal_event_id is not null then
    v_op := 'delete';
  else
    return new;
  end if;

  insert into public.planner_outbox (user_id, task_id, op, payload)
  values (
    new.user_id, new.id, v_op,
    jsonb_build_object('gcal_event_id', new.gcal_event_id)
  )
  on conflict (task_id, op) where done_at is null do nothing;

  return new;
end;
$$;

-- A remote apply must not look like a local edit either, or every change made
-- in Google would win the next conflict comparison against itself.
create or replace function public.planner_bump_local_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if coalesce(current_setting('planner.skip_enqueue', true), '') = 'on' then
    return new;
  end if;
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

-- ------------------------------------------------------------ remote apply --

-- The only path by which a Google-side change reaches a task. Field rule:
-- schedule times follow Google, title/notes stay local. Last writer wins on
-- the schedule, and a losing remote change is logged, never dropped silently.
create or replace function public.planner_apply_remote_event(
  p_user_id uuid,
  p_gcal_event_id text,
  p_start timestamptz,
  p_end timestamptz,
  p_cancelled boolean,
  p_etag text,
  p_remote_updated timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.planner_tasks%rowtype;
begin
  select * into v_task
  from public.planner_tasks
  where user_id = p_user_id and gcal_event_id = p_gcal_event_id
  for update;

  if not found then
    return 'no_task';
  end if;

  perform set_config('planner.skip_enqueue', 'on', true);

  if p_cancelled then
    -- The event was deleted in Google: the task survives, unscheduled.
    update public.planner_tasks
       set scheduled_start = null,
           scheduled_end   = null,
           status          = case when status = 'scheduled' then 'inbox' else status end,
           gcal_event_id   = null,
           gcal_etag       = null
     where id = v_task.id;
    return 'unscheduled';
  end if;

  if v_task.scheduled_start is not distinct from p_start
     and v_task.scheduled_end is not distinct from p_end then
    -- Same times: our own write coming back, or a no-op edit. Keep etag fresh.
    update public.planner_tasks set gcal_etag = p_etag where id = v_task.id;
    return 'noop';
  end if;

  if v_task.local_updated_at > p_remote_updated then
    -- Local edit is newer: it wins, the pending outbox row will push it out.
    insert into public.planner_conflicts
      (user_id, task_id, field, local_value, remote_value, resolved_as)
    values
      (p_user_id, v_task.id, 'schedule',
       v_task.scheduled_start::text || ' / ' || v_task.scheduled_end::text,
       p_start::text || ' / ' || p_end::text,
       'local');
    return 'local_wins';
  end if;

  update public.planner_tasks
     set scheduled_start = p_start,
         scheduled_end   = p_end,
         status          = case when status = 'inbox' then 'scheduled' else status end,
         gcal_etag       = p_etag
   where id = v_task.id;
  return 'applied';
end;
$$;

revoke all on function public.planner_apply_remote_event(uuid, text, timestamptz, timestamptz, boolean, text, timestamptz) from public, anon, authenticated;
grant execute on function public.planner_apply_remote_event(uuid, text, timestamptz, timestamptz, boolean, text, timestamptz) to service_role;

-- --------------------------------------------------------- reconcile repair --

-- Set-based drift repair, called after the nightly full resync. Three cases:
-- broken links are relinked, orphaned events queue a delete, ghost links
-- queue a recreate. Returns counts so the run log shows what was touched.
create or replace function public.planner_reconcile_repair(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_relinked int := 0;
  v_orphan_deletes int := 0;
  v_recreates int := 0;
begin
  -- a) task alive+scheduled, link lost, but its event exists: relink.
  with candidates as (
    select t.id as task_id, m.gcal_event_id, m.etag
    from public.planner_calendar_events m
    join public.planner_tasks t
      on t.id::text = m.raw->'extendedProperties'->'private'->>'plannerTaskId'
    where m.user_id = p_user_id and t.user_id = p_user_id
      and m.owned_by_app and m.status <> 'cancelled'
      and t.deleted_at is null and t.scheduled_start is not null
      and t.gcal_event_id is null
  )
  update public.planner_tasks t
     set gcal_event_id = c.gcal_event_id, gcal_etag = c.etag
    from candidates c where t.id = c.task_id;
  get diagnostics v_relinked = row_count;

  -- b) live app-owned event whose task is gone or unscheduled: queue delete.
  insert into public.planner_outbox (user_id, task_id, op, payload)
  select m.user_id,
         (m.raw->'extendedProperties'->'private'->>'plannerTaskId')::uuid,
         'delete',
         jsonb_build_object('gcal_event_id', m.gcal_event_id)
  from public.planner_calendar_events m
  where m.user_id = p_user_id
    and m.owned_by_app and m.status <> 'cancelled'
    and (m.raw->'extendedProperties'->'private'->>'plannerTaskId')
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and not exists (
      select 1 from public.planner_tasks t
      where t.id::text = m.raw->'extendedProperties'->'private'->>'plannerTaskId'
        and t.deleted_at is null and t.scheduled_start is not null
    )
  on conflict (task_id, op) where done_at is null do nothing;
  get diagnostics v_orphan_deletes = row_count;

  -- c) task points at an event that no longer exists: clear and recreate.
  with ghosts as (
    update public.planner_tasks t
       set gcal_event_id = null, gcal_etag = null
     where t.user_id = p_user_id
       and t.deleted_at is null and t.scheduled_start is not null
       and t.gcal_event_id is not null
       and not exists (
         select 1 from public.planner_calendar_events m
         where m.user_id = p_user_id
           and m.gcal_event_id = t.gcal_event_id
           and m.status <> 'cancelled'
       )
    returning t.id, t.user_id
  )
  insert into public.planner_outbox (user_id, task_id, op, payload)
  select user_id, id, 'create', '{}'::jsonb from ghosts
  on conflict (task_id, op) where done_at is null do nothing;
  get diagnostics v_recreates = row_count;

  return jsonb_build_object(
    'relinked', v_relinked,
    'orphan_deletes', v_orphan_deletes,
    'recreates', v_recreates
  );
end;
$$;

revoke all on function public.planner_reconcile_repair(uuid) from public, anon, authenticated;
grant execute on function public.planner_reconcile_repair(uuid) to service_role;
