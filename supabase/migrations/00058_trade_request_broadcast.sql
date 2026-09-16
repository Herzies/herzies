-- Push incoming trade requests instead of polling for them.
--
-- The desktop client ran a /trade-pending poll every 5s for as long as the
-- window was hidden (trade_watch_loop in lib.rs), which is most of the time an
-- always-on menu-bar app is running. Production stats showed that loop
-- dominating backend call volume, and it still made a trade request take up to
-- 5s to appear.
--
-- Same shape as chat (00027_chat_broadcast.sql): a trigger emits the request to
-- a private Realtime topic and the client renders straight from the payload.
-- The difference is the topic — chat is global and broadcasts to everyone on
-- "chat", whereas a trade request is addressed to exactly one person, so the
-- topic is per-user ("trade:<target user id>") and the authorization policy
-- below is what stops anyone subscribing to someone else's.
--
-- The payload matches PendingTradeRequest in src-tauri/src/types.rs so the
-- client can ingest it without a follow-up fetch.

create or replace function public.broadcast_trade_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  initiator record;
begin
  -- Only a freshly created invite is worth notifying about. Joins, locks,
  -- accepts and cancels are UPDATEs and this trigger is INSERT-only, but the
  -- guard keeps that intent explicit if a trade is ever inserted mid-flow.
  if new.state is distinct from 'pending' then
    return null;
  end if;

  select name, friend_code
    into initiator
  from public.herzies
  where user_id = new.initiator_id;

  -- A failed broadcast must never roll back the trade. This trigger runs
  -- inside the INSERT's transaction, and trades move real items and currency,
  -- so a transient realtime.send error (a missing realtime.messages partition
  -- is the usual cause) would otherwise turn a notification problem into a
  -- "you can't start a trade" problem. The fallback poll in lib.rs covers the
  -- dropped notification.
  begin
    perform realtime.send(
      jsonb_build_object(
        'tradeId', new.id,
        'fromName', coalesce(initiator.name, 'Unknown'),
        'fromFriendCode', coalesce(initiator.friend_code, '')
      ),
      'trade_request',                     -- event name clients listen for
      'trade:' || new.target_id::text,     -- topic (matches the channel name)
      true                                 -- private (see the policy below)
    );
  exception
    when others then
      raise warning 'broadcast_trade_request failed for trade %: %', new.id, sqlerrm;
  end;

  return null;
end;
$$;

drop trigger if exists trg_broadcast_trade_request on public.trades;
create trigger trg_broadcast_trade_request
  after insert on public.trades
  for each row execute function public.broadcast_trade_request();

-- Broadcast authorization. Unlike the chat policy, this one is not a constant
-- topic check: a user may only receive on the topic named after their own id,
-- which is what keeps trade invites private.
drop policy if exists "Users can receive their own trade broadcasts"
  on realtime.messages;
create policy "Users can receive their own trade broadcasts"
  on realtime.messages
  for select
  to authenticated
  using (
    (select realtime.topic()) = 'trade:' || (select auth.uid())::text
    and realtime.messages.extension = 'broadcast'
  );
