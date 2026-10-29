-- /muted lists each stop with an undo button; the button needs a short id.
alter table public.mailbot_muted add column id bigint generated always as identity;
create unique index mailbot_muted_id_key on public.mailbot_muted (id);
