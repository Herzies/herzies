-- Push every change to a trade to both sides, instead of having them poll.
--
-- TradeView polled /trade/status every 650ms per player for as long as a trade
-- was open (the hottest route in the app), and a partner's offer, lock or
-- accept still took up to one poll interval plus a round trip to show. Now each
-- change is broadcast the moment it commits, on the per-user "trade:<user id>"
-- topics 00058 opened for trade invites (its authorization policy already
-- keeps each user to their own topic). The client applies the payload as is,
-- and polls only as a fallback.
--
-- `version` orders what arrives: a broadcast and a poll answer can cross, and
-- the older must never replace the newer. It's bumped by the database, not
-- set by the routes, so it can't go backwards between two app servers'
-- clocks the way updated_at could.

alter table public.trades
  add column if not exists version bigint not null default 0;

create or replace function public.bump_trade_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

drop trigger if exists trg_bump_trade_version on public.trades;
create trigger trg_bump_trade_version
  before update on public.trades
  for each row execute function public.bump_trade_version();

-- The payload is /trade/status's trade, without the names: they can't change
-- mid-trade, and the client has them from its first poll.
create or replace function public.broadcast_trade_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  payload jsonb;
begin
  payload := jsonb_build_object(
    'id', new.id,
    'initiatorId', new.initiator_id,
    'targetId', new.target_id,
    'initiatorOffer', new.initiator_offer,
    'targetOffer', new.target_offer,
    'state', new.state,
    'initiatorAccepted', new.initiator_accepted,
    'targetAccepted', new.target_accepted,
    'createdAt', new.created_at,
    'expiresAt', new.expires_at,
    'version', new.version
  );

  -- As in 00058: a failed broadcast must never roll back the change itself
  -- (trades move real items and currency). The client's fallback poll picks
  -- up anything dropped.
  begin
    perform realtime.send(
      payload, 'trade_update', 'trade:' || new.initiator_id::text, true
    );
    perform realtime.send(
      payload, 'trade_update', 'trade:' || new.target_id::text, true
    );
  exception
    when others then
      raise warning 'broadcast_trade_update failed for trade %: %', new.id, sqlerrm;
  end;

  return null;
end;
$$;

drop trigger if exists trg_broadcast_trade_update on public.trades;
create trigger trg_broadcast_trade_update
  after update on public.trades
  for each row execute function public.broadcast_trade_update();

-- Trigger functions only, as in 00097: nobody calls them over the API.
revoke execute on function public.bump_trade_version() from public, anon, authenticated;
revoke execute on function public.broadcast_trade_update() from public, anon, authenticated;
