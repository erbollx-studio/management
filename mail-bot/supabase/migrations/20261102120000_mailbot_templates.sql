-- Templates: every email is sorted into 🔴 urgent insurance, 💰 insurance
-- payment, 🧾 invoice / payment or ⭐ your people. An inbox in "templates"
-- mode sends only those (plus its own words) to Telegram; the rest goes to the
-- daily list. "all" sends every email. Existing inboxes start on templates.

alter table public.mailbot_inboxes
  add column mode text not null default 'templates' check (mode in ('templates', 'all'));

-- ⭐ People whose emails always come through: one address, or a domain for everyone there.
create table public.mailbot_people (
  id         bigint generated always as identity primary key,
  entry      text not null unique,
  name       text not null default '',
  note       text not null default '',
  created_at timestamptz not null default now()
);

alter table public.mailbot_people enable row level security;
revoke all on public.mailbot_people from anon, authenticated;
grant all on public.mailbot_people to service_role;
