-- Boss damage from the cave.
--
-- The boss is fought live now: the Town server (packages/town-server) runs
-- the fight and reports the damage herzies deal, in batches, through the
-- `town-vitals` edge function. Rewards, the leaderboard and settling are
-- unchanged; only where damage comes from moves (see 00073).
--
-- A batch is applied exactly once: the Town server re-sends one unchanged
-- until it hears back, and damage is additive, so a retry after a lost reply
-- must not count twice. The batch id is the idempotency key; its row and the
-- damage it names are one transaction, so a batch that fails halfway
-- leaves no trace and can be retried whole.

CREATE TABLE IF NOT EXISTS public.boss_damage_batches (
  batch      text PRIMARY KEY,
  event_id   uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.boss_damage_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.boss_damage_batches FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS boss_damage_batches_created_idx
  ON public.boss_damage_batches (created_at);

-- p_damage: [{"uid": "<uuid>", "damage": <number>}, ...]
-- Returns {"applied": bool, "hp": <boss hp after>, "killed": bool}.
CREATE OR REPLACE FUNCTION public.apply_boss_damage_batch(
  p_batch  text,
  p_event  uuid,
  p_damage jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows   integer;
  v_item   jsonb;
  v_hp     real;
  v_kill   boolean;
  v_res    record;
BEGIN
  IF p_batch IS NULL OR length(p_batch) = 0 OR length(p_batch) > 200 THEN
    RAISE EXCEPTION 'bad batch id';
  END IF;
  IF jsonb_typeof(p_damage) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_damage) > 200 THEN
    RAISE EXCEPTION 'bad damage list';
  END IF;

  INSERT INTO public.boss_damage_batches (batch, event_id)
  VALUES (p_batch, p_event)
  ON CONFLICT (batch) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    -- Already applied: report where the boss stands now.
    SELECT bs.hp, bs.killed INTO v_hp, v_kill
      FROM public.boss_state bs WHERE bs.event_id = p_event;
    RETURN jsonb_build_object(
      'applied', false, 'hp', v_hp, 'killed', coalesce(v_kill, false));
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_damage) LOOP
    -- One player's bad row mustn't lose everyone else's damage.
    BEGIN
      SELECT * INTO v_res FROM public.deal_boss_damage(
        p_event,
        (v_item ->> 'uid')::uuid,
        LEAST(GREATEST((v_item ->> 'damage')::real, 0), 1000000)
      );
      IF v_res.hp IS NOT NULL THEN v_hp := v_res.hp; END IF;
    EXCEPTION WHEN others THEN
      CONTINUE;
    END;
  END LOOP;

  SELECT bs.hp, bs.killed INTO v_hp, v_kill
    FROM public.boss_state bs WHERE bs.event_id = p_event;
  RETURN jsonb_build_object(
    'applied', true, 'hp', v_hp, 'killed', coalesce(v_kill, false));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_boss_damage_batch(text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;

-- The boss as the Town server and ticket function need it: hp, max hp, the
-- window, whether it is open right now.
CREATE OR REPLACE FUNCTION public.open_boss_json()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'event',  e.id,
    'until',  extract(epoch FROM e.ends_at)::bigint,
    'hp',     bs.hp,
    'maxHp',  bs.max_hp
  )
  FROM public.events e
  JOIN public.boss_state bs ON bs.event_id = e.id
  WHERE e.type = 'boss_fight'
    AND e.active
    AND e.starts_at <= now()
    AND e.ends_at > now()
    AND NOT bs.killed
    AND bs.hp > 0
  ORDER BY e.starts_at DESC
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.open_boss_json()
  FROM PUBLIC, anon, authenticated;

-- Old batches are only ever looked at while a retry is in flight.
SELECT cron.unschedule('purge-boss-damage-batches')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-boss-damage-batches');
SELECT cron.schedule(
  'purge-boss-damage-batches',
  '17 4 * * *',
  $$DELETE FROM public.boss_damage_batches WHERE created_at < now() - interval '7 days'$$
);
