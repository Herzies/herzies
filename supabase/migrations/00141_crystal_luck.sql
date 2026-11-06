-- ===========================================================================
-- 00141 — Crystal drops roll with the luck worn while listening
--
-- 00140 rolled a Crystal's drops with the luck worn at the moment of
-- attuning, so luck gear only had to go on for the attune. Now the Crystal
-- keeps crystal_luck: the average luck over the drop minutes it holds,
-- weighted by minutes, as each sync charged them. Attuning rolls with it.
--
-- NULL = not known (minutes charged before this, or none held): the next
-- charge with a luck takes it for those minutes too, and an attune before
-- then falls back to the luck worn (the attune-crystal function).
-- ===========================================================================

ALTER TABLE public.herzies
  ADD COLUMN IF NOT EXISTS crystal_luck numeric;

-- charge_crystal as 00140, plus p_luck: the luck this sync's minutes were
-- listened with. NULL (a sync from before this) leaves crystal_luck alone.
DROP FUNCTION IF EXISTS public.charge_crystal(uuid, numeric, numeric, numeric);

CREATE OR REPLACE FUNCTION public.charge_crystal(
  p_user                 uuid,
  p_minutes              numeric,
  p_xp                   numeric,
  p_backlog_drop_minutes numeric DEFAULT 0,
  p_luck                 numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_h      public.herzies%ROWTYPE;
  v_m      numeric := greatest(0, least(coalesce(p_minutes, 0), 1440));
  v_xp     numeric := greatest(0, least(coalesce(p_xp, 0), 10000000));
  v_back   numeric := greatest(0, least(coalesce(p_backlog_drop_minutes, 0), 100000));
  v_luck   numeric := CASE WHEN p_luck IS NULL THEN NULL
                           ELSE greatest(0, least(p_luck, 10000)) END;
  v_under  numeric;
  v_eff    numeric;
  v_ratio  numeric;
  v_held   numeric;
  v_added  numeric;
BEGIN
  SELECT * INTO v_h FROM public.herzies WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'herzie not found';
  END IF;

  v_under := least(v_m, greatest(0, public.crystal_capacity(v_h.crystal_tier) - greatest(0, v_h.crystal_fill)));
  v_eff   := v_under + (v_m - v_under) * 0.25;
  v_ratio := CASE WHEN v_m > 0 THEN v_eff / v_m ELSE 0 END;
  v_held  := greatest(0, v_h.crystal_drop_minutes);
  v_added := v_eff + v_back;

  UPDATE public.herzies
     SET crystal_fill         = greatest(0, crystal_fill) + v_m,
         crystal_xp           = crystal_xp + v_xp * v_ratio,
         crystal_drop_minutes = crystal_drop_minutes + v_added,
         -- Minute-weighted average. Minutes held with no luck known take
         -- this sync's.
         crystal_luck         = CASE
           WHEN v_luck IS NULL THEN crystal_luck
           WHEN crystal_luck IS NULL OR v_held + v_added <= 0 THEN v_luck
           ELSE (crystal_luck * v_held + v_luck * v_added) / (v_held + v_added)
         END
   WHERE user_id = p_user
  RETURNING * INTO v_h;

  RETURN jsonb_build_object(
    'fillBefore', v_h.crystal_fill - v_m,
    'effectiveMinutes', v_eff,
    'herzie', to_jsonb(v_h)
  );
END;
$$;

-- crystal_attune as 00140; the minutes left over keep their average, and an
-- emptied Crystal forgets it.
CREATE OR REPLACE FUNCTION public.crystal_attune(
  p_user              uuid,
  p_expected_attunes  integer,
  p_rolls             integer,
  p_items             jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_h      public.herzies%ROWTYPE;
  v_xp     integer;
  v_rolls  integer;
  v_given  integer := 0;
BEGIN
  SELECT * INTO v_h FROM public.herzies WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'herzie not found';
  END IF;
  IF v_h.crystal_attunes IS DISTINCT FROM p_expected_attunes THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stale',
      'herzie', to_jsonb(v_h));
  END IF;

  v_xp    := greatest(0, floor(v_h.crystal_xp))::integer;
  v_rolls := greatest(0, least(coalesce(p_rolls, 0),
               floor(v_h.crystal_drop_minutes / 10)::integer, 60));

  IF v_rolls > 0 AND jsonb_typeof(p_items) = 'array' THEN
    INSERT INTO public.pending_drops (user_id, item_id, dropped_at)
    SELECT p_user, i.id, now() + interval '45 seconds'
      FROM (SELECT e AS item_id
              FROM jsonb_array_elements_text(p_items) WITH ORDINALITY AS t(e, n)
             WHERE n <= v_rolls * 3) AS x
      JOIN public.items i ON i.id = x.item_id;
    GET DIAGNOSTICS v_given = ROW_COUNT;
  END IF;

  UPDATE public.herzies
     SET pending_xp           = pending_xp + v_xp,
         crystal_xp           = greatest(0, crystal_xp - v_xp),
         crystal_drop_minutes = greatest(0, crystal_drop_minutes - v_rolls * 10),
         crystal_luck         = CASE
           WHEN crystal_drop_minutes - v_rolls * 10 <= 0 THEN NULL
           ELSE crystal_luck
         END,
         crystal_fill         = 0,
         crystal_attunes      = crystal_attunes + 1
   WHERE user_id = p_user
  RETURNING * INTO v_h;

  RETURN jsonb_build_object(
    'ok', true,
    'xp', v_xp,
    'rolls', v_rolls,
    'given', v_given,
    'herzie', to_jsonb(v_h),
    'pendingDrops', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', d.id, 'itemId', d.item_id, 'droppedAt', d.dropped_at
             ) ORDER BY d.dropped_at), '[]'::jsonb)
        FROM public.pending_drops d
       WHERE d.user_id = p_user
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.charge_crystal(uuid, numeric, numeric, numeric, numeric)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crystal_attune(uuid, integer, integer, jsonb)
  FROM PUBLIC, anon, authenticated;
