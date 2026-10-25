-- The Tower Guard: he stands by the Tower, sure no one lasts up there, and
-- pays the month's best climber once the month is out.
--
-- - tower_grant: a best floor's time (which breaks ties, the earlier one
--   winning) only moves when the floor actually rises. It used to move on
--   every batch, so climbing on without beating your best lost you ties.
-- - Tower config: `topRewardItemId` (what #1 gets) and `excludeHerzies`
--   (herzie names never ranked for it: the owner's). A Tower pays only if
--   its config names a reward. Series templates and the Towers still to
--   end get the default (Power Dice 3); Towers already over don't, so
--   nothing is back-paid.
-- - tower_winner: an event's #1 (best floor, then earliest), skipping the
--   excluded.
-- - tower_guard_json: what the guard shows — the running Tower's top 3 and
--   your place, last Tower's winner, and whether you have a reward waiting.
-- - claim_tower_reward: hands it over (once per event: event_claims).

-- ---------------------------------------------------------------------------
-- tower_grant — as in 00115, except for when updated_at moves.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tower_grant(
  p_user     uuid,
  p_event    uuid,
  p_batch    text,
  p_xp       integer,
  p_cleared  integer,
  p_item_ids text[],
  p_xp_cap   integer,
  p_drop_cap integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows  int;
  v_today date := (now() AT TIME ZONE 'utc')::date;
  v_daily public.tower_daily%ROWTYPE;
  v_xp    int;
  v_room  int;
  v_drops jsonb := '[]'::jsonb;
  v_item  text;
  v_id    uuid;
  v_lands timestamptz := now() + interval '90 seconds';
BEGIN
  IF p_batch IS NULL OR length(p_batch) = 0 OR length(p_batch) > 200 THEN
    RAISE EXCEPTION 'bad batch id';
  END IF;
  IF coalesce(array_length(p_item_ids, 1), 0) > 50 THEN
    RAISE EXCEPTION 'too many drops';
  END IF;

  INSERT INTO public.tower_batches (batch) VALUES (p_batch)
  ON CONFLICT (batch) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN jsonb_build_object('drops', '[]'::jsonb);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.herzies WHERE user_id = p_user) THEN
    RETURN jsonb_build_object('drops', '[]'::jsonb);
  END IF;

  IF coalesce(p_cleared, 0) > 0 THEN
    INSERT INTO public.tower_progress (user_id, event_id, best_floor)
    VALUES (p_user, p_event, p_cleared)
    ON CONFLICT (user_id, event_id) DO UPDATE
      SET best_floor = greatest(public.tower_progress.best_floor, excluded.best_floor),
          -- Only a new best moves the time: it breaks ties (the earlier
          -- one wins), so playing on without climbing mustn't cost you.
          updated_at = CASE
            WHEN excluded.best_floor > public.tower_progress.best_floor
              THEN now()
            ELSE public.tower_progress.updated_at
          END;
  END IF;

  INSERT INTO public.tower_daily (user_id, day) VALUES (p_user, v_today)
  ON CONFLICT (user_id, day) DO NOTHING;
  SELECT * INTO v_daily FROM public.tower_daily
   WHERE user_id = p_user AND day = v_today
   FOR UPDATE;

  v_xp := greatest(0, least(coalesce(p_xp, 0), p_xp_cap - v_daily.xp));
  v_room := greatest(0, p_drop_cap - v_daily.drops);

  IF v_xp > 0 THEN
    UPDATE public.herzies SET pending_xp = pending_xp + v_xp
     WHERE user_id = p_user;
  END IF;

  FOREACH v_item IN ARRAY coalesce(p_item_ids, '{}'::text[]) LOOP
    EXIT WHEN v_room <= 0;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.items WHERE id = v_item);
    INSERT INTO public.pending_drops (user_id, item_id, dropped_at, source_event)
    VALUES (p_user, v_item, v_lands, p_event)
    RETURNING id INTO v_id;
    v_drops := v_drops || jsonb_build_object('id', v_id, 'item', v_item);
    v_room := v_room - 1;
  END LOOP;

  UPDATE public.tower_daily
     SET xp = xp + v_xp,
         drops = drops + jsonb_array_length(v_drops)
   WHERE user_id = p_user AND day = v_today;

  RETURN jsonb_build_object('drops', v_drops);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.tower_grant(uuid, uuid, text, integer, integer, text[], integer, integer)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The default reward, for series and the events they already made.
-- ---------------------------------------------------------------------------
UPDATE public.event_series
   SET config_template = '{"topRewardItemId": "power-dice-3", "excludeHerzies": ["music_lover69"]}'::jsonb
 WHERE type = 'tower'
   AND coalesce(config_template, '{}'::jsonb) = '{}'::jsonb;

UPDATE public.events
   SET config = '{"topRewardItemId": "power-dice-3", "excludeHerzies": ["music_lover69"]}'::jsonb
 WHERE type = 'tower'
   AND ends_at > now()
   AND coalesce(config, '{}'::jsonb) = '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- tower_ranked — an event's climbers in order (best floor, then whoever got
-- there first), the excluded left out of the ranks but still listed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tower_ranked(p_event uuid)
RETURNS TABLE (
  user_id  uuid,
  name     text,
  level    int,
  stage    int,
  floor    int,
  at       timestamptz,
  excluded boolean,
  rnk      bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH ex AS (
    SELECT lower(x) AS name
      FROM public.events e,
           jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(e.config -> 'excludeHerzies') = 'array'
                  THEN e.config -> 'excludeHerzies' ELSE '[]'::jsonb END
           ) AS x
     WHERE e.id = p_event
  ),
  rows AS (
    SELECT tp.user_id, h.name, h.level, h.stage, tp.best_floor AS floor,
           tp.updated_at,
           EXISTS (SELECT 1 FROM ex WHERE ex.name = lower(h.name)) AS excluded
      FROM public.tower_progress tp
      JOIN public.herzies h ON h.user_id = tp.user_id
     WHERE tp.event_id = p_event
       AND tp.best_floor > 0
  )
  SELECT r.user_id, r.name, r.level, r.stage, r.floor, r.updated_at,
         r.excluded,
         row_number() OVER (
           PARTITION BY r.excluded
           ORDER BY r.floor DESC, r.updated_at ASC, r.user_id
         ) AS rnk
    FROM rows r;
$$;

-- An event's #1, or NULL.
CREATE OR REPLACE FUNCTION public.tower_winner(p_event uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT user_id FROM public.tower_ranked(p_event)
   WHERE NOT excluded AND rnk = 1;
$$;

-- The oldest ended Tower with a reward that this herzie won and hasn't
-- been paid for.
CREATE OR REPLACE FUNCTION public.tower_unclaimed_win(p_user uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id
    FROM public.events e
   WHERE e.type = 'tower'
     AND e.active
     AND e.ends_at <= now()
     AND coalesce(e.config ->> 'topRewardItemId', '') <> ''
     AND public.tower_winner(e.id) = p_user
     AND NOT EXISTS (
       SELECT 1 FROM public.event_claims c
        WHERE c.event_id = e.id AND c.user_id = p_user
     )
   ORDER BY e.ends_at ASC
   LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- tower_guard_json — everything the guard says:
--   { current: { event, endsAt, top: [{rank,name,level,stage,floor}],
--                you: {rank, floor} | null } | null,
--     last: { event, name, floor } | null,
--     reward: { eligible, itemId, event } }
-- `you.rank` counts the excluded too (it's where you stand on the board).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tower_guard_json(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cur   public.events%ROWTYPE;
  v_last  public.events%ROWTYPE;
  v_win   uuid;
  v_out   jsonb := '{}'::jsonb;
  v_top   jsonb;
  v_you   jsonb;
  v_lastj jsonb;
  v_claim uuid;
  v_item  text;
BEGIN
  SELECT * INTO v_cur FROM public.events
   WHERE type = 'tower' AND active
     AND starts_at <= now() AND ends_at > now()
   ORDER BY starts_at DESC LIMIT 1;

  IF v_cur.id IS NOT NULL THEN
    WITH board AS (
      SELECT user_id, name, level, stage, floor,
             row_number() OVER (ORDER BY floor DESC, at ASC, user_id) AS place
        FROM public.tower_ranked(v_cur.id)
    )
    SELECT
      coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'rank', place, 'name', name, 'level', level,
                 'stage', stage, 'floor', floor) ORDER BY place)
          FROM board WHERE place <= 3), '[]'::jsonb),
      (SELECT jsonb_build_object('rank', place, 'floor', floor)
         FROM board WHERE user_id = p_user)
      INTO v_top, v_you;

    v_out := v_out || jsonb_build_object('current', jsonb_build_object(
      'event', v_cur.id,
      'endsAt', extract(epoch FROM v_cur.ends_at)::bigint,
      'top', v_top,
      'you', v_you));
  ELSE
    v_out := v_out || jsonb_build_object('current', NULL::jsonb);
  END IF;

  -- Last Tower that paid out (one with a reward).
  SELECT * INTO v_last FROM public.events
   WHERE type = 'tower' AND active AND ends_at <= now()
     AND coalesce(config ->> 'topRewardItemId', '') <> ''
   ORDER BY ends_at DESC LIMIT 1;
  IF v_last.id IS NOT NULL THEN
    v_win := public.tower_winner(v_last.id);
  END IF;
  IF v_win IS NOT NULL THEN
    SELECT jsonb_build_object('event', v_last.id, 'name', r.name, 'floor', r.floor)
      INTO v_lastj
      FROM public.tower_ranked(v_last.id) r
     WHERE r.user_id = v_win;
  END IF;
  v_out := v_out || jsonb_build_object('last', v_lastj);

  v_claim := public.tower_unclaimed_win(p_user);
  IF v_claim IS NOT NULL THEN
    SELECT coalesce(nullif(config ->> 'topRewardItemId', ''), 'power-dice-3')
      INTO v_item FROM public.events WHERE id = v_claim;
  END IF;
  v_out := v_out || jsonb_build_object('reward', jsonb_build_object(
    'eligible', v_claim IS NOT NULL,
    'event', v_claim,
    'itemId', v_item));

  RETURN v_out;
END;
$$;

-- ---------------------------------------------------------------------------
-- claim_tower_reward — pay out the oldest unpaid win: the claim row (one per
-- event) and the item, together. { ok, itemId, event, state } or
-- { ok: false, reason: 'not-found' | 'nothing-to-claim' }.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_tower_reward(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event uuid;
  v_item  text;
BEGIN
  PERFORM 1 FROM public.herzies WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-found');
  END IF;

  v_event := public.tower_unclaimed_win(p_user);
  IF v_event IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'nothing-to-claim');
  END IF;

  SELECT coalesce(nullif(config ->> 'topRewardItemId', ''), 'power-dice-3')
    INTO v_item FROM public.events WHERE id = v_event;
  IF NOT EXISTS (SELECT 1 FROM public.items WHERE id = v_item) THEN
    v_item := 'power-dice-3';
  END IF;

  INSERT INTO public.event_claims (event_id, user_id)
  VALUES (v_event, p_user)
  ON CONFLICT (event_id, user_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'nothing-to-claim');
  END IF;

  INSERT INTO public.item_units (user_id, item_id) VALUES (p_user, v_item);

  RETURN jsonb_build_object(
    'ok', true, 'itemId', v_item, 'event', v_event,
    'state', public.item_state(p_user));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.tower_ranked(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tower_winner(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tower_unclaimed_win(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tower_guard_json(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_tower_reward(uuid) FROM PUBLIC, anon, authenticated;
