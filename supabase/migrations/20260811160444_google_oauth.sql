-- ============================================================================
-- Phase 1 — Google Calendar connection
--
-- Three storage tiers, deliberately separated by who may read them:
--
--   planner_google_accounts  connection metadata, readable by its owner.
--                            Contains no secrets, so the client can render
--                            connection state without a server round trip.
--   planner_google_tokens    access-token cache and a pointer to the Vault
--                            secret. No grants at all -- service_role only.
--   planner_oauth_states     in-flight OAuth handshakes. Also server-only.
--
-- The refresh token itself never lands in a table column: it goes into Vault,
-- and the two SECURITY DEFINER wrappers below are the only way in or out.
-- See docs/ARCHITECTURE.md §6 for why this app owns the OAuth flow rather than
-- leaning on Supabase Auth's provider tokens.
-- ============================================================================

-- ------------------------------------------------------- account metadata --

create table public.planner_google_accounts (
  user_id              uuid primary key references auth.users (id) on delete cascade,
  google_sub           text not null,
  email                text,
  scopes               text not null default '',
  status               text not null default 'connected'
                         constraint planner_google_accounts_status_valid
                         check (status in ('connected', 'needs_reauth', 'revoked')),
  connected_at         timestamptz not null default now(),
  last_health_check_at timestamptz,
  last_error           text,
  updated_at           timestamptz not null default now()
);

create trigger planner_google_accounts_set_updated_at
  before update on public.planner_google_accounts
  for each row execute function public.planner_set_updated_at();

alter table public.planner_google_accounts enable row level security;

-- Read-only to the client: the connection is created and mutated by Edge
-- Functions running as service_role, never by the browser.
create policy planner_google_accounts_select on public.planner_google_accounts
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.planner_google_accounts from anon, authenticated;
grant select on public.planner_google_accounts to authenticated;

-- --------------------------------------------------------- token storage --

create table public.planner_google_tokens (
  user_id                 uuid primary key
                            references public.planner_google_accounts (user_id) on delete cascade,
  refresh_token_secret_id uuid not null,
  access_token            text,
  access_token_expires_at timestamptz,
  updated_at              timestamptz not null default now()
);

create trigger planner_google_tokens_set_updated_at
  before update on public.planner_google_tokens
  for each row execute function public.planner_set_updated_at();

-- RLS on with zero policies: even if a grant were restored by accident, no row
-- would be visible. service_role bypasses RLS by design.
alter table public.planner_google_tokens enable row level security;
revoke all on public.planner_google_tokens from anon, authenticated;

-- ------------------------------------------------------- OAuth handshakes --

create table public.planner_oauth_states (
  state         text primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  code_verifier text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '10 minutes'
);

create index planner_oauth_states_expiry_idx on public.planner_oauth_states (expires_at);

alter table public.planner_oauth_states enable row level security;
revoke all on public.planner_oauth_states from anon, authenticated;

-- ------------------------------------------------------------ Vault gates --

-- The refresh token crosses this boundary and nowhere else. Both functions are
-- SECURITY DEFINER because `vault` is not reachable by the service_role through
-- PostgREST, and both are executable only by service_role.

create or replace function public.planner_store_refresh_token(p_user_id uuid, p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
begin
  select refresh_token_secret_id into v_existing
  from public.planner_google_tokens where user_id = p_user_id;

  if v_existing is not null then
    perform vault.update_secret(v_existing, p_token);
    return v_existing;
  end if;

  return vault.create_secret(
    p_token,
    'google_refresh_' || p_user_id::text,
    'Google Calendar refresh token'
  );
end;
$$;

create or replace function public.planner_read_refresh_token(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_token     text;
begin
  select refresh_token_secret_id into v_secret_id
  from public.planner_google_tokens where user_id = p_user_id;

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_token
  from vault.decrypted_secrets where id = v_secret_id;

  return v_token;
end;
$$;

revoke all on function public.planner_store_refresh_token(uuid, text) from public, anon, authenticated;
revoke all on function public.planner_read_refresh_token(uuid)        from public, anon, authenticated;
grant execute on function public.planner_store_refresh_token(uuid, text) to service_role;
grant execute on function public.planner_read_refresh_token(uuid)        to service_role;
