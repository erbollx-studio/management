-- Once a minute: the mail-bot function checks every connected inbox.
-- The bearer is read from mailbot_config at call time, so it never lives in the job text.
select cron.schedule(
  'mailbot-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://vqexlrqphddnnbveppbl.supabase.co/functions/v1/mail-bot/cron',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select value from public.mailbot_config where key = 'cron_token')
    ),
    timeout_milliseconds := 10000
  );
  $$
);
