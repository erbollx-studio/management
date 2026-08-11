-- Supabase's default privileges on `public` hand every role full DML, so these
-- tables were reachable by `anon` with only row-level security standing in the
-- way. Nothing in this app is public, so anon loses the grant outright: an
-- unauthenticated caller is refused at the permission layer (401) before any
-- policy is consulted, rather than quietly receiving an empty array (200).
revoke all on public.planner_tasks    from anon;
revoke all on public.planner_projects from anon;
