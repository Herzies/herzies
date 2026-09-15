-- expire_stale_trades() is a WRITE, and it was being called on every trade
-- READ: /api/trade/status (polled every 650ms per open trade, even while the
-- window is blurred), /api/trade/ongoing (5s), /api/trade/pending, and the
-- trade-pending edge function (5s while hidden). Production stats over 135
-- days showed 1.93M calls — roughly one every 6 seconds, around the clock,
-- from ~26 users.
--
-- Sweeping on a schedule instead. The read paths move to deriving expiry from
-- expires_at rather than triggering the write (see the route changes alongside
-- this migration). Every caller that invoked the RPC:
--
--   - /api/trade/pending and the trade-pending function already filtered
--     `expires_at > now()`, so the call there was pure redundancy.
--   - /api/trade/ongoing now filters on expires_at too.
--   - /api/trade/status now reports a non-terminal trade past its expires_at
--     as cancelled without writing.
--
-- /api/trade/create and /api/trade/join KEEP calling it directly: both are
-- rare, user-triggered writes whose guards ("do you already have an active
-- trade", "is this trade still joinable") read state rather than expires_at,
-- and they need the flip to have actually happened. They are a negligible
-- share of the call volume.
--
-- IMPORTANT — routes that did NOT call the RPC but depended on someone else's
-- call having run: /api/trade/offer, /lock and /accept all read trades.state
-- with no expires_at filter, and so did execute_trade(). With /trade/status
-- polling at 650ms they were effectively protected within ~1s; on a 60s cron
-- they would not be. 00059_execute_trade_expiry_guard.sql closes that at the
-- point where it matters — the atomic function that moves items and currency —
-- so the guarantee no longer depends on the sweep's timing at all.
--
-- What the sweep is still for: persisting the state change so cancelled trades
-- settle, and so anything reading `state` without an expires_at filter shows
-- the right thing. Running every minute keeps the worst-case display staleness
-- to 60s, which is well inside the trade expiry window.

create extension if not exists pg_cron;

do $$
begin
  if exists (
    select 1 from cron.job where jobname = 'expire-stale-trades'
  ) then
    perform cron.unschedule('expire-stale-trades');
  end if;

  perform cron.schedule(
    'expire-stale-trades',
    '* * * * *',
    $cron$ select public.expire_stale_trades(); $cron$
  );
end;
$$;

-- Sweep whatever is already stale at migration time.
select public.expire_stale_trades();
