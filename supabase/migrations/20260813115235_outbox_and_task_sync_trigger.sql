-- Phase 3 — the write path. Tasks never call Google in the request path:
-- a trigger enqueues work here, and the drain worker pushes it out with
-- retries. See docs/ARCHITECTURE.md §7.
--
-- NOTE: planner_enqueue_task_sync as defined here was superseded in
-- 20260813162345_two_way_sync_infrastructure with echo suppression added.

create table public.planner_outbox (
  id              bigserial primary key,
  user_id         uuid not null references auth.users (id) on delete cascade,
  task_id         uuid not null,
  op              text not null check (op in ('create', 'update', 'delete')),
  payload         jsonb not null default '{}'::jsonb,
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  done_at         timestamptz,
  created_at      timestamptz not null default now()
);

-- One pending row per (task, op): a second edit before the drain runs is
-- already covered, because the drain reads current task state, not the payload.
create unique index planner_outbox_pending_idx
  on public.planner_outbox (task_id, op) where done_at is null;

create index planner_outbox_due_idx
  on public.planner_outbox (next_attempt_at) where done_at is null;

alter table public.planner_outbox enable row level security;
revoke all on public.planner_outbox from anon, authenticated;

-- Enqueue on any user-meaningful change. Bookkeeping writes (gcal_event_id,
-- gcal_etag after a successful push) deliberately do not re-enqueue.
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

create trigger planner_tasks_enqueue_sync
  after insert or update on public.planner_tasks
  for each row execute function public.planner_enqueue_task_sync();
