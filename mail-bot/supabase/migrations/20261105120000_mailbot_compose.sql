-- ✍️ New emails written in Telegram (/new), and ✨ Polish (an AI rewrite)
-- on them and on replies. Service-role only, like the other mailbot tables.

-- A new email while it is being written: inbox → To → Subject → text →
-- preview → ✅ Send. `step` is what the bot waits for. messages: the Telegram
-- messages of this draft (/new, the bot's questions, the typed answers); an
-- answer typed under one of them finds this draft, and they all leave the chat
-- once it is sent or cancelled. preview_id: the preview with ✅ Send.
-- original: the owner's own text while body holds the polished one. ✅ Send
-- deletes the row first, so a double tap sends once. Rows older than a day
-- are dropped.
create table public.mailbot_drafts (
  key        text primary key,
  inbox_id   int references public.mailbot_inboxes (id) on delete cascade,
  step       text not null default 'inbox' check (step in ('inbox', 'to', 'subject', 'body', 'ready')),
  recipients text not null default '',
  subject    text not null default '',
  body       text not null default '',
  original   text,
  preview_id bigint,
  messages   bigint[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.mailbot_drafts enable row level security;
revoke all on public.mailbot_drafts from anon, authenticated;
grant all on public.mailbot_drafts to service_role;

-- ✨ Polish on a reply: the owner's own text, while body holds the polished one.
alter table public.mailbot_pending_replies add column original text;

-- AI keys for ✨ Polish, in Vault like the bot token. /aikey saves them; the
-- bot reads them only when Polish is tapped. groq: the API key. cloudflare:
-- "<account_id> <token>". Only these two names can be saved.

create or replace function public.mailbot_store_ai_key(p_name text, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := 'mailbot_ai_' || p_name;
  v_id   uuid;
begin
  if p_name not in ('groq', 'cloudflare') then
    raise exception 'unknown AI key name';
  end if;
  select id into v_id from vault.secrets where name = v_name;
  if v_id is null then
    perform vault.create_secret(p_secret, v_name, 'Mail bot AI key for Polish');
  else
    perform vault.update_secret(v_id, p_secret);
  end if;
end;
$$;

create or replace function public.mailbot_ai_key(p_name text)
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'mailbot_ai_' || p_name;
$$;

-- /aikey shows which keys are set, never the keys: this returns names only.
create or replace function public.mailbot_ai_key_names()
returns text[]
language sql
security definer
set search_path = ''
as $$
  select coalesce(array_agg(substr(name, 12) order by name), '{}')
  from vault.secrets
  where name in ('mailbot_ai_groq', 'mailbot_ai_cloudflare');
$$;

revoke execute on function public.mailbot_store_ai_key(text, text) from public, anon, authenticated;
revoke execute on function public.mailbot_ai_key(text) from public, anon, authenticated;
revoke execute on function public.mailbot_ai_key_names() from public, anon, authenticated;
grant execute on function public.mailbot_store_ai_key(text, text) to service_role;
grant execute on function public.mailbot_ai_key(text) to service_role;
grant execute on function public.mailbot_ai_key_names() to service_role;
