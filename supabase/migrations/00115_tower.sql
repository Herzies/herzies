-- The Tower: an event island fought floor by floor, alone, against mobs
-- the Town server runs. This keeps what lasts: each herzie's best floor per
-- Tower event (they come back one above it), and what kills paid — a little
-- XP and now and then an item, both capped per day so the Tower never beats
-- listening.
--
-- Kills arrive from the Town server through town-vitals (service role) in
-- named batches, like boss damage; a replayed batch pays nothing.
--
-- XP can't be added to herzies.xp directly: sync writes that column whole
-- from what it read, so a grant landing mid-sync would be lost. It waits in
-- herzies.pending_xp until the next sync takes it (take_pending_xp) and
-- levels the herzie up with it.

-- A Tower can be a series too.
ALTER TABLE public.event_series DROP CONSTRAINT IF EXISTS event_series_type_check;
ALTER TABLE public.event_series
  ADD CONSTRAINT event_series_type_check
  CHECK (type IN ('song_hunt', 'boss_fight', 'merchant', 'tower'));

ALTER TABLE public.herzies
  ADD COLUMN IF NOT EXISTS pending_xp integer NOT NULL DEFAULT 0;

-- Best floor cleared, per herzie per Tower event.
CREATE TABLE IF NOT EXISTS public.tower_progress (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_id   uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  best_floor integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id)
);
ALTER TABLE public.tower_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tower_progress FROM anon, authenticated;

-- What the Tower has paid each herzie today (UTC), for the daily caps.
CREATE TABLE IF NOT EXISTS public.tower_daily (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day     date NOT NULL,
  xp      integer NOT NULL DEFAULT 0,
  drops   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
ALTER TABLE public.tower_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tower_daily FROM anon, authenticated;

-- Batches already paid, so a retry after a lost reply pays nothing.
CREATE TABLE IF NOT EXISTS public.tower_batches (
  batch      text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tower_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tower_batches FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- open_tower_json — the Tower claim for a herzie's ticket: the running Tower
-- event, when it ends (unix seconds), and the floor they start on (one past
-- their best). NULL while no Tower is on.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.open_tower_json(p_user uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'event', e.id,
    'until', extract(epoch FROM e.ends_at)::bigint,
    'floor', coalesce(tp.best_floor, 0) + 1
  )
  FROM public.events e
  LEFT JOIN public.tower_progress tp
    ON tp.event_id = e.id AND tp.user_id = p_user
  WHERE e.type = 'tower'
    AND e.active
    AND e.starts_at <= now()
    AND e.ends_at > now()
  ORDER BY e.starts_at DESC
  LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- tower_grant — pay a batch of kills: the best floor cleared, the XP (into
-- pending_xp) and the dropped items (on the ground at once, like boss loot:
-- dated 90 seconds ahead so a worn spirit doesn't fetch them from home before
-- the herzie sees them fall in the Tower), each under the day's cap. `p_item_ids` are the
-- drops town-vitals already rolled (listening's weights and luck). Like the
-- boss's, they bypass the ground cap: they're earned, not idle drops.
--
-- Returns { drops: [{ id, item }] }: what landed, for the Tower to drop.
-- A replayed batch returns no drops and pays nothing.
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
          updated_at = now();
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

-- ---------------------------------------------------------------------------
-- take_pending_xp — sync's half: what the Tower has paid since the last
-- sync, taken (and zeroed) in one step.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.take_pending_xp(p_user uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH old AS (
    SELECT user_id, pending_xp FROM public.herzies
     WHERE user_id = p_user AND pending_xp > 0
     FOR UPDATE
  )
  UPDATE public.herzies h
     SET pending_xp = 0
    FROM old
   WHERE h.user_id = old.user_id
  RETURNING old.pending_xp;
$$;

REVOKE EXECUTE ON FUNCTION public.open_tower_json(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tower_grant(uuid, uuid, text, integer, integer, text[], integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.take_pending_xp(uuid)
  FROM PUBLIC, anon, authenticated;

-- Old batches only matter while a retry is in flight.
SELECT cron.unschedule('purge-tower-batches')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-tower-batches');
SELECT cron.schedule(
  'purge-tower-batches',
  '17 4 * * *',
  $$DELETE FROM public.tower_batches WHERE created_at < now() - interval '2 days'$$
);
