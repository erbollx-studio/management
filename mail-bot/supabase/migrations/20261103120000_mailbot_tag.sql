-- The tag: an email with the Gmail label "erbol" (mailbot_config.tag_label
-- changes the name) always comes to the chat, whatever the templates and
-- filters say. Each inbox remembers that label's id and when it last looked.

alter table public.mailbot_inboxes
  add column tag_label_id   text,
  add column tag_checked_at timestamptz;
