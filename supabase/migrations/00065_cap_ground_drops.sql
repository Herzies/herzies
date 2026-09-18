-- Cap the ground at 10 uncollected drops.
--
-- Drops used to accumulate without limit, so a player returning after a long
-- break met hundreds of them. At the cap a rolled drop is now forfeited, not
-- queued: processSync spends the roll (drop_rolls_done advances) and nothing
-- lands. A queue would make the cap invisible, since everything owed would
-- still arrive eventually. Losing drops to a full ground is also what makes
-- an auto-collecting pet (the Greedy Spirit) worth equipping rather than a
-- mere convenience.
--
-- The 10 is duplicated in GROUND_DROP_CAP (packages/shared/src/items.ts) for
-- client-side use; the two must stay in sync.

-- Return type changes void -> int (the count actually inserted), and CREATE OR
-- REPLACE cannot change a return type — the old version has to be dropped
-- explicitly, same trap 00054 hit with arity.
DROP FUNCTION IF EXISTS public.roll_pending_drops(uuid, text[]);

CREATE FUNCTION public.roll_pending_drops(p_user_id uuid, p_item_ids text[])
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
  -- on the floor (forfeited, per the note above).
  WITH ins AS (
    INSERT INTO public.pending_drops (user_id, item_id)
    SELECT p_user_id, x
    FROM (SELECT unnest(p_item_ids) AS x LIMIT v_room) s
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  RETURN v_inserted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Creating the function grants EXECUTE to PUBLIC — revoke explicitly for all
-- three roles, same as 00053/00054/00061 (see 00052 for why relying on
-- ordering alone doesn't work). pending_drops is only ever written through
-- these SECURITY DEFINER functions, called by the service-role admin client.
REVOKE EXECUTE ON FUNCTION public.roll_pending_drops(uuid, text[]) FROM PUBLIC, anon, authenticated;
