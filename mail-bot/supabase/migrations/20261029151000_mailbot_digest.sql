-- Applied after the function stopped reading topics.
alter table public.mailbot_inboxes drop column topics;

-- Daily list of what the filters held back, at 20:00 Bishkek (14:00 UTC).
select cron.schedule(
  'mailbot-digest',
  '0 14 * * *',
  $$
  select net.http_post(
    url := 'https://vqexlrqphddnnbveppbl.supabase.co/functions/v1/mail-bot/cron',
    body := '{"job":"digest"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select value from public.mailbot_config where key = 'cron_token')
    ),
    timeout_milliseconds := 10000
  );
  $$
);
