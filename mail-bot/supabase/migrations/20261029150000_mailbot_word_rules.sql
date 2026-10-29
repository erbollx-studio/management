-- Filters are the owner's own words now, not fixed topics: keep any topic
-- that was switched on as a word of the same name.
update public.mailbot_inboxes set keywords = keywords || topics where cardinality(topics) > 0;

-- Emails a filter held back, for the daily digest and /skipped.
create table public.mailbot_skipped (
  inbox_id    int not null references public.mailbot_inboxes (id) on delete cascade,
  message_id  text not null,
  sender      text not null default '',
  subject     text not null default '',
  received_at timestamptz not null default now(),
  primary key (inbox_id, message_id)
);
alter table public.mailbot_skipped enable row level security;
revoke all on public.mailbot_skipped from anon, authenticated;
grant all on public.mailbot_skipped to service_role;
