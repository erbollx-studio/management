-- The money list: 🧾 and 💰 emails come to the chat only from senders on it.
-- A sender's entry is their company domain (or the address, for free mail).
-- allowed: their money emails come. asked: the bot showed one with ✓ Allow /
-- ✕ Not money and waits for the answer. denied: their money emails go to the
-- daily list.

create table public.mailbot_senders (
  id         bigint generated always as identity primary key,
  entry      text not null unique,
  status     text not null check (status in ('allowed', 'asked', 'denied')),
  created_at timestamptz not null default now()
);

alter table public.mailbot_senders enable row level security;
revoke all on public.mailbot_senders from anon, authenticated;
grant all on public.mailbot_senders to service_role;

-- The ones the owner named: the factoring company, the payments app, the tax office.
insert into public.mailbot_senders (entry, status) values
  ('ecapital.com', 'allowed'),
  ('relaypayments.com', 'allowed'),
  ('tax.nm.gov', 'allowed');
