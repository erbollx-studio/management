-- Per-inbox filters: when topics or keywords are set, only matching mail is posted.
alter table public.mailbot_inboxes
  add column topics   text[] not null default '{}',
  add column keywords text[] not null default '{}';
