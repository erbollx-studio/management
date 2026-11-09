-- "Can't reach Gmail" alerts only after 10 minutes of failures, once, and a
-- "works again" note after. failing_since: when checking this inbox started
-- failing (null while it works). alerted_at: when you were told.
alter table public.mailbot_inboxes
  add column failing_since timestamptz,
  add column alerted_at    timestamptz;
