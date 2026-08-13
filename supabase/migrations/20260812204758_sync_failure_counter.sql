-- PostgREST cannot express `col = col + 1`, and the failure streak is what the
-- phase 5 watchdog escalates on, so the increment gets its own function.
create or replace function public.planner_bump_sync_failure(p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.planner_sync_state
     set consecutive_failures = consecutive_failures + 1
   where user_id = p_user_id;
$$;

revoke all on function public.planner_bump_sync_failure(uuid) from public, anon, authenticated;
grant execute on function public.planner_bump_sync_failure(uuid) to service_role;
