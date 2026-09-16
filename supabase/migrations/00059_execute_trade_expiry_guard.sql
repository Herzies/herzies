-- Guard execute_trade() against expired trades.
--
-- execute_trade (00008_security_hardening.sql) checks state = 'both_locked'
-- and both accepted flags, but never looked at expires_at. That was survivable
-- only because expire_stale_trades() ran on every trade read —
-- /api/trade/status polls at 650ms, so a timed-out trade was flipped to
-- 'cancelled' within about a second and the state check then refused it.
--
-- 00057 moved that sweep to a once-a-minute cron, widening the window in which
-- a timed-out trade still reads as 'both_locked' from ~1s to up to 60s. On the
-- one code path that actually moves items and currency, that is not a window
-- to leave open.
--
-- Guarding here rather than in the callers because this is the atomic function
-- that performs the exchange: /api/trade/accept, /api/trade/offer and
-- /api/trade/lock all read trades.state without an expires_at filter, and none
-- of them ever called expire_stale_trades() themselves — they inherited the
-- sweep from whichever poll happened to run first. This makes the guarantee
-- independent of the sweep's timing, which is stronger than what was there
-- before 00057 rather than merely a restoration of it.
--
-- (/api/trade/accept pushes expires_at out by 5 minutes when a side accepts,
-- so a trade being actively completed is nowhere near its deadline. This
-- rejects only genuinely abandoned ones.)
--
-- WHY THIS IS A DO BLOCK AND NOT A CREATE OR REPLACE:
--
-- The function body is ~70 lines of inventory and currency arithmetic. Copying
-- it forward by hand to add one line is exactly the kind of edit where a
-- silently dropped statement corrupts player inventories — on the first attempt
-- at this migration, hand-transcribing the body lost the zero-quantity pruning
-- step, which would have left traded-away items behind as {"item": 0}.
--
-- So the body is not retyped. This reads the live definition out of pg_proc and
-- splices one line in after a fixed anchor, which cannot drift from whatever
-- 00008 (or any later migration) actually installed. It is idempotent, and it
-- fails loudly rather than silently if the anchor is ever edited away.

do $$
declare
  src    text;
  anchor text := '  IF NOT t.initiator_accepted OR NOT t.target_accepted THEN RETURN false; END IF;';
  guard  text := '  IF t.expires_at IS NOT NULL AND t.expires_at < now() THEN RETURN false; END IF;';
begin
  select p.prosrc into src
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'execute_trade';

  if src is null then
    raise exception 'execute_trade() not found — expected 00008 to have created it';
  end if;

  if position(guard in src) > 0 then
    raise notice 'execute_trade() already carries the expiry guard; nothing to do';
    return;
  end if;

  if position(anchor in src) = 0 then
    raise exception 'anchor line not found in execute_trade(); refusing to guess where the guard belongs';
  end if;

  src := replace(src, anchor, anchor || E'\n' || guard);

  execute format(
    'CREATE OR REPLACE FUNCTION public.execute_trade(trade_id uuid) '
    'RETURNS boolean AS %L LANGUAGE plpgsql SECURITY DEFINER SET search_path = %L',
    src, ''
  );
end;
$$;

-- CREATE OR REPLACE re-grants EXECUTE to anon/authenticated, so re-apply the
-- 00052 lockdown. (00052 exists precisely because revoking from anon and
-- authenticated without PUBLIC silently does nothing.)
REVOKE EXECUTE ON FUNCTION public.execute_trade(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.execute_trade(uuid) TO authenticated;
