-- Recurring task templates + per-task energy level. The generator runs daily
-- via pg_cron and is also callable by the owner right after editing templates,
-- so a new template produces today's task immediately rather than tomorrow.
-- (Applied to the live project as version 20260813190500; see repo history.)

alter table public.planner_tasks
  add column energy text check (energy in ('light', 'heavy')),
  add column template_id uuid;

create table public.planner_task_templates (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title            text not null check (length(btrim(title)) between 1 and 500),
  notes            text,
  project_id       uuid references public.planner_projects (id) on delete set null,
  priority         smallint not null default 0 check (priority between 0 and 3),
  estimate_minutes integer check (estimate_minutes > 0 and estimate_minutes <= 1440),
  energy           text check (energy in ('light', 'heavy')),
  repeat_rule      text not null default 'daily' check (repeat_rule in ('daily', 'weekdays', 'custom')),
  custom_days      smallint[] check (custom_days <@ array[1,2,3,4,5,6,7]::smallint[]),
  due_time         time,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create trigger planner_task_templates_set_updated_at
  before update on public.planner_task_templates
  for each row execute function public.planner_set_updated_at();

alter table public.planner_task_templates enable row level security;

create policy planner_task_templates_select on public.planner_task_templates
  for select to authenticated using ((select auth.uid()) = user_id);
create policy planner_task_templates_insert on public.planner_task_templates
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy planner_task_templates_update on public.planner_task_templates
  for update to authenticated using ((select auth.uid()) = user_id)
                               with check ((select auth.uid()) = user_id);
create policy planner_task_templates_delete on public.planner_task_templates
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.planner_task_templates from anon;
grant select, insert, update, delete on public.planner_task_templates to authenticated;

-- One generated task per template per day, soft-deleted ones included: if the
-- user deletes today's instance, regeneration must not resurrect it.
create unique index planner_tasks_template_day_idx
  on public.planner_tasks (template_id, ((due_at at time zone 'UTC')::date))
  where template_id is not null;

-- Generates today's tasks for one user. Callable by the owner (client nudge
-- after editing templates) and by cron as postgres (auth.uid() is null there).
create or replace function public.planner_generate_recurring(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_dow smallint := extract(isodow from now())::smallint;
  t record;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'not allowed';
  end if;

  for t in
    select * from public.planner_task_templates
    where user_id = p_user_id and active
      and (repeat_rule = 'daily'
        or (repeat_rule = 'weekdays' and v_dow between 1 and 5)
        or (repeat_rule = 'custom' and custom_days @> array[v_dow]))
  loop
    begin
      insert into public.planner_tasks
        (user_id, title, notes, project_id, priority, estimate_minutes, energy,
         template_id, due_at)
      values
        (t.user_id, t.title, t.notes, t.project_id, t.priority, t.estimate_minutes, t.energy,
         t.id,
         case when t.due_time is not null
              then date_trunc('day', now()) + t.due_time
              else date_trunc('day', now()) + interval '23 hours 59 minutes' end);
      v_count := v_count + 1;
    exception when unique_violation then
      -- already generated today (or generated and deleted) -- skip
      null;
    end;
  end loop;

  return v_count;
end;
$$;

grant execute on function public.planner_generate_recurring(uuid) to authenticated, service_role;

create or replace function public.planner_generate_recurring_all()
returns integer
language sql
security definer
set search_path = ''
as $$
  select coalesce(sum(public.planner_generate_recurring(user_id)), 0)::integer
  from (select distinct user_id from public.planner_task_templates where active) u;
$$;

revoke all on function public.planner_generate_recurring_all() from public, anon, authenticated;
grant execute on function public.planner_generate_recurring_all() to service_role;

-- Daily at 00:05 UTC.
select cron.schedule(
  'planner-recurring',
  '5 0 * * *',
  $$ select public.planner_generate_recurring_all(); $$
);
