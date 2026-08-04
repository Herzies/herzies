-- Ephemeral global chat: automatically purge messages older than the retention
-- window so the chat never accumulates long-lived history.
--
-- Keep the interval below in sync with CHAT_RETENTION_HOURS in
-- packages/shared/src/chat.ts (currently 24 hours).

-- pg_cron is used to run the purge on a recurring schedule.
create extension if not exists pg_cron;

-- Deletes any chat message past the retention window. SECURITY DEFINER so the
-- cron job (which runs as the table owner) can delete regardless of RLS.
create or replace function public.delete_expired_chat_messages()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.chat_messages
  where created_at < now() - interval '24 hours';
$$;

-- (Re)schedule the purge to run hourly. Running hourly (rather than once a day)
-- means nothing in the chat is ever meaningfully older than the retention
-- window, and avoids a single large daily delete.
do $$
begin
  if exists (
    select 1 from cron.job where jobname = 'purge-expired-chat-messages'
  ) then
    perform cron.unschedule('purge-expired-chat-messages');
  end if;

  perform cron.schedule(
    'purge-expired-chat-messages',
    '0 * * * *',
    $cron$ select public.delete_expired_chat_messages(); $cron$
  );
end;
$$;

-- Clear out anything already past the retention window at migration time.
select public.delete_expired_chat_messages();
