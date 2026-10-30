-- Listening drops land a little in the future.
--
-- The desktop now shows what drops while you listen in its 3D world: each
-- comes out of a small black hole near your herzie, and a worn spirit flies
-- over and fetches it. But a spirit's server-side sweep (processSync)
-- collects every drop that has landed (dropped_at <= now()) in the same
-- sync that rolled it, so a spirit owner never saw a drop arrive, let alone
-- be fetched.
--
-- So rolled drops now land 45 seconds after they're rolled, the way boss
-- and Tower loot already lands 90 seconds out (00105) to give the cave the
-- first go. Inside that window the app (when it's open and showing the
-- world) plays the arrival and the fetch, and collects the drop through
-- collect-drop as any pickup. When it isn't open, the sweep still takes it
-- on the first sync after the 45 seconds, as before. Nothing else changes:
-- the cap, the forfeit at the cap, the grants.
--
-- dropped_at is only ever compared against now() for that sweep (and the
-- "Inventory full" check that rides on it); older clients show a drop
-- whatever its dropped_at, so they're unaffected.
--
-- Same signature and return type as 00065, so CREATE OR REPLACE is enough,
-- and the EXECUTE grants are kept; the REVOKE is repeated anyway, as every
-- drop function's migration does (see 00052).

CREATE OR REPLACE FUNCTION public.roll_pending_drops(p_user_id uuid, p_item_ids text[])
RETURNS int AS $$
DECLARE
  v_room int;
  v_inserted int;
BEGIN
  -- Serializes against a concurrent sync for this same herzie (the desktop
  -- app and the Spotify cron can both be rolling). Without it two callers
  -- could each read "1 slot free" and both insert into it.
  PERFORM 1 FROM public.herzies WHERE user_id = p_user_id FOR UPDATE;

  SELECT GREATEST(0, 10 - count(*)) INTO v_room
  FROM public.pending_drops
  WHERE user_id = p_user_id;

  IF v_room = 0 THEN
    RETURN 0;
  END IF;

  -- LIMIT lives in a subquery rather than on the INSERT ... SELECT itself:
  -- whichever of the rolled items fit go on the ground, the rest are dropped
  -- on the floor (forfeited, per 00065).
  WITH ins AS (
    INSERT INTO public.pending_drops (user_id, item_id, dropped_at)
    SELECT p_user_id, x, now() + interval '45 seconds'
    FROM (SELECT unnest(p_item_ids) AS x LIMIT v_room) s
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  RETURN v_inserted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.roll_pending_drops(uuid, text[]) FROM PUBLIC, anon, authenticated;
