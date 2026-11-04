-- Reminders the bot sends later, checked once a minute after the mail check.
-- later: ⏰ on a card ("bring it back at 9:00"). deadline: a due date found in
-- an email, 3 days before and on the day. unanswered: "nobody answered" check
-- 4 working hours after a ⭐ or 📌 email. The row is deleted when sent.

create table public.mailbot_reminders (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind in ('later', 'deadline', 'unanswered')),
  inbox_id   int not null references public.mailbot_inboxes (id) on delete cascade,
  message_id text not null,
  thread_id  text not null,
  due_at     timestamptz not null,
  note       text not null default '',
  tries      int not null default 0,
  created_at timestamptz not null default now()
);

create index mailbot_reminders_due on public.mailbot_reminders (due_at);
-- One deadline reminder per conversation and time, one open "nobody answered" check per conversation.
create unique index mailbot_reminders_deadline on public.mailbot_reminders (inbox_id, thread_id, due_at)
  where kind = 'deadline';
create unique index mailbot_reminders_unanswered on public.mailbot_reminders (inbox_id, thread_id)
  where kind = 'unanswered';

alter table public.mailbot_reminders enable row level security;
revoke all on public.mailbot_reminders from anon, authenticated;
grant all on public.mailbot_reminders to service_role;
