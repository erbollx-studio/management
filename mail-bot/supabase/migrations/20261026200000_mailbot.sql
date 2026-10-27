-- Mail bot: Gmail inboxes connected with Google sign-in, posting to one Telegram chat.
-- Lives next to the planner tables, touches none of them. Every table is
-- service-role only (RLS on, no policies, no grants): only the mail-bot edge
-- function reads or writes them.

create table public.mailbot_config (
  key   text primary key,
  value text not null
);

create table public.mailbot_inboxes (
  id                      serial primary key,
  email                   text not null unique,
  label                   text,
  refresh_token_secret_id uuid,
  access_token            text,
  access_token_expires_at timestamptz,
  history_id              text,
  status                  text not null default 'connected' check (status in ('connected', 'needs_reauth')),
  last_error              text,
  last_checked_at         timestamptz,
  connected_at            timestamptz not null default now()
);

-- One row per /connect link; deleted when the callback uses it.
create table public.mailbot_oauth_states (
  state         text primary key,
  code_verifier text not null,
  login_hint    text,
  expires_at    timestamptz not null default now() + interval '15 minutes'
);

-- Emails already posted. The insert is the claim that stops two overlapping
-- cron runs from posting the same email twice.
create table public.mailbot_seen (
  inbox_id   int not null references public.mailbot_inboxes (id) on delete cascade,
  message_id text not null,
  seen_at    timestamptz not null default now(),
  primary key (inbox_id, message_id)
);

-- Replies typed in Telegram, waiting for the Send tap.
create table public.mailbot_pending_replies (
  key        text primary key,
  inbox_id   int not null references public.mailbot_inboxes (id) on delete cascade,
  message_id text not null,
  body       text not null,
  created_at timestamptz not null default now()
);

create table public.mailbot_muted (
  entry      text primary key,
  created_at timestamptz not null default now()
);

alter table public.mailbot_config          enable row level security;
alter table public.mailbot_inboxes         enable row level security;
alter table public.mailbot_oauth_states    enable row level security;
alter table public.mailbot_seen            enable row level security;
alter table public.mailbot_pending_replies enable row level security;
alter table public.mailbot_muted           enable row level security;

revoke all on public.mailbot_config, public.mailbot_inboxes, public.mailbot_oauth_states,
  public.mailbot_seen, public.mailbot_pending_replies, public.mailbot_muted from anon, authenticated;
revoke all on sequence public.mailbot_inboxes_id_seq from anon, authenticated;
grant all on public.mailbot_config, public.mailbot_inboxes, public.mailbot_oauth_states,
  public.mailbot_seen, public.mailbot_pending_replies, public.mailbot_muted to service_role;
grant usage on sequence public.mailbot_inboxes_id_seq to service_role;

-- Refresh tokens and the bot token live in Vault, never in plain columns.

create or replace function public.mailbot_store_refresh_token(p_inbox_id int, p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
begin
  select refresh_token_secret_id into v_existing
  from public.mailbot_inboxes where id = p_inbox_id;

  if v_existing is not null then
    perform vault.update_secret(v_existing, p_token);
    return v_existing;
  end if;

  v_existing := vault.create_secret(p_token, 'mailbot_refresh_' || p_inbox_id::text, 'Mail bot Gmail refresh token');
  update public.mailbot_inboxes set refresh_token_secret_id = v_existing where id = p_inbox_id;
  return v_existing;
end;
$$;

create or replace function public.mailbot_read_refresh_token(p_inbox_id int)
returns text
language sql
security definer
set search_path = ''
as $$
  select s.decrypted_secret
  from public.mailbot_inboxes i
  join vault.decrypted_secrets s on s.id = i.refresh_token_secret_id
  where i.id = p_inbox_id;
$$;

create or replace function public.mailbot_delete_inbox(p_inbox_id int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  select refresh_token_secret_id into v_secret from public.mailbot_inboxes where id = p_inbox_id;
  delete from public.mailbot_inboxes where id = p_inbox_id;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
  end if;
end;
$$;

-- Stored once by hand: select vault.create_secret('<token>', 'mailbot_telegram_token');
create or replace function public.mailbot_bot_token()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'mailbot_telegram_token';
$$;

revoke execute on function public.mailbot_store_refresh_token(int, text) from public, anon, authenticated;
revoke execute on function public.mailbot_read_refresh_token(int) from public, anon, authenticated;
revoke execute on function public.mailbot_delete_inbox(int) from public, anon, authenticated;
revoke execute on function public.mailbot_bot_token() from public, anon, authenticated;
grant execute on function public.mailbot_store_refresh_token(int, text) to service_role;
grant execute on function public.mailbot_read_refresh_token(int) to service_role;
grant execute on function public.mailbot_delete_inbox(int) to service_role;
grant execute on function public.mailbot_bot_token() to service_role;

-- Secrets for the webhook, the cron call and the one-time pairing link,
-- generated here so they never appear in code.
insert into public.mailbot_config (key, value) values
  ('pair_code', encode(extensions.gen_random_bytes(8), 'hex')),
  ('webhook_secret', encode(extensions.gen_random_bytes(24), 'hex')),
  ('cron_token', encode(extensions.gen_random_bytes(24), 'hex')),
  ('paused', 'false'),
  ('time_zone', 'Asia/Bishkek');
