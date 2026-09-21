-- Boss Fight admin controls.
--
-- The weekly cron stays the default (00074), but an admin can now:
--   * turn the weekly spawn off entirely          (boss_fight_settings.auto_spawn)
--   * skip one specific week                       (boss_fight_skips)
--   * set the defaults the weekly spawn uses       (boss_fight_settings)
--   * replace a week's boss with a hand-made one   (an admin-created boss_fight
--     event whose window overlaps the cron's makes the cron no-op)
--
-- The cron still only calls a plain SQL function, per 00074: the enable/skip
-- decision lives in spawn_scheduled_boss_fight so that spawn_boss_fight keeps
-- working by hand (and in tests) regardless of whether the schedule is on.

-- ---------------------------------------------------------------------------
-- Settings — a single row. Defaults reproduce 00073's behaviour exactly, so
-- nothing changes until an admin touches it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.boss_fight_settings (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  auto_spawn         boolean NOT NULL DEFAULT true,
  -- NULL means "scale with active players" (the 00073 formula).
  default_hp         real CHECK (default_hp IS NULL OR default_hp > 0),
  reward_item_id     text NOT NULL DEFAULT 'cd',
  top_reward_item_id text DEFAULT 'cd',
  top_count          int NOT NULL DEFAULT 3 CHECK (top_count >= 0),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.boss_fight_settings (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;

-- Weeks the cron should sit out, keyed by the UTC date the cron fires on
-- (a Thursday). A row for a date the cron never fires on is harmless.
CREATE TABLE IF NOT EXISTS public.boss_fight_skips (
  week_of    date PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.boss_fight_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.boss_fight_skips ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.boss_fight_settings FROM anon, authenticated;
REVOKE ALL ON public.boss_fight_skips FROM anon, authenticated;


-- ---------------------------------------------------------------------------
-- spawn_boss_fight — same signature as 00073, so existing callers and grants
-- are untouched. Two behaviour changes:
--
-- 1. The "already a boss" guard is now an overlap test on the new window,
--    not "any boss ends in the future". An admin can schedule a boss weeks
--    ahead; under the old guard that would silently block every weekly spawn
--    until it ran. Overlap still refuses a second live boss, which is what
--    keeps sync_context's "the active boss" well-defined.
-- 2. HP and rewards fall back to boss_fight_settings before the hardcoded
--    values.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.spawn_boss_fight(
  p_hated_genres text[]     DEFAULT NULL,
  p_hp           real       DEFAULT NULL,
  p_ends_at      timestamptz DEFAULT NULL,
  p_title        text       DEFAULT NULL
)
RETURNS uuid AS $$
DECLARE
  -- GENRES minus 'pop'. Pop is the fallback for every unmatched Last.fm tag,
  -- for the Spotify path, and for a Last.fm timeout — a boss that hated pop
  -- would take damage from essentially every listen in the game.
  v_pool      text[] := ARRAY[
    'rock','hip-hop','electronic','jazz','classical','r&b','country',
    'metal','indie','latin','folk','blues','punk','soul'
  ];
  v_settings  public.boss_fight_settings%ROWTYPE;
  v_genres    text[];
  v_active    int;
  v_hp        real;
  v_starts_at timestamptz := now();
  v_ends_at   timestamptz;
  v_event_id  uuid;
BEGIN
  -- Four days: Thursday 00:00 UTC to Monday 00:00 UTC, leaving Mon-Wed free
  -- for other event types.
  v_ends_at := COALESCE(p_ends_at, v_starts_at + interval '4 days');

  -- No-op if any boss overlaps this window — live, or hand-scheduled by an
  -- admin to replace this week's.
  IF EXISTS (
    SELECT 1 FROM public.events e
     WHERE e.type = 'boss_fight'
       AND e.active
       AND e.starts_at < v_ends_at
       AND e.ends_at > v_starts_at
  ) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_settings FROM public.boss_fight_settings WHERE id;

  v_genres := COALESCE(
    p_hated_genres,
    ARRAY(SELECT unnest(v_pool) ORDER BY random() LIMIT 3)
  );

  SELECT count(*) INTO v_active
    FROM public.herzies h
   WHERE h.last_synced_at > now() - interval '7 days';

  -- 35 damage-minutes per active player over the four-day window. The floor
  -- matters more than the ceiling at current player counts: an oversized boss
  -- always escapes, and the event never pays out.
  v_hp := COALESCE(
    p_hp,
    v_settings.default_hp,
    LEAST(50000, GREATEST(900, v_active * 35.0))
  );

  INSERT INTO public.events (type, title, description, active, starts_at, ends_at, config)
  VALUES (
    'boss_fight',
    COALESCE(p_title, 'Nohoot Henry'),
    'Listen to what it hates.',
    true,
    v_starts_at,
    v_ends_at,
    jsonb_build_object(
      'hatedGenres',     to_jsonb(v_genres),
      'rewardItemId',    COALESCE(v_settings.reward_item_id, 'cd'),
      'topRewardItemId', CASE WHEN v_settings.id IS NULL THEN 'cd'
                              ELSE v_settings.top_reward_item_id END,
      'topCount',        COALESCE(v_settings.top_count, 3),
      'maxHp',           v_hp
    )
  )
  RETURNING id INTO v_event_id;

  INSERT INTO public.boss_state (event_id, hp, max_hp)
  VALUES (v_event_id, v_hp, v_hp);

  RETURN v_event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.spawn_boss_fight(text[], real, timestamptz, text)
  FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- spawn_scheduled_boss_fight — what the cron calls. Honours the admin's
-- on/off switch and per-week skips, then defers to spawn_boss_fight.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.spawn_scheduled_boss_fight()
RETURNS uuid AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.boss_fight_settings WHERE id AND NOT auto_spawn
  ) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.boss_fight_skips
     WHERE week_of = (now() AT TIME ZONE 'utc')::date
  ) THEN
    RETURN NULL;
  END IF;

  RETURN public.spawn_boss_fight();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.spawn_scheduled_boss_fight()
  FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- admin_set_boss_hp — create or resize a boss's HP pool from the admin page.
--
-- An admin-created boss_fight event has no boss_state row until this runs,
-- and without one sync_context never reports it and deal_boss_damage drops
-- every hit. Resizing takes the same row lock as deal_boss_damage so it cannot
-- interleave with a hit: damage already dealt is preserved (hp moves by the
-- same amount max_hp does), and shrinking the pool below that damage is
-- refused rather than turned into a kill nobody landed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_boss_hp(
  p_event_id uuid,
  p_max_hp   real
)
RETURNS void AS $$
DECLARE
  v_state public.boss_state%ROWTYPE;
  v_dealt real;
BEGIN
  IF p_max_hp IS NULL OR p_max_hp <= 0 THEN
    RAISE EXCEPTION 'Boss HP must be positive';
  END IF;

  SELECT * INTO v_state
    FROM public.boss_state
   WHERE event_id = p_event_id
     FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.boss_state (event_id, hp, max_hp)
    VALUES (p_event_id, p_max_hp, p_max_hp);
    RETURN;
  END IF;

  IF v_state.max_hp = p_max_hp THEN
    RETURN;
  END IF;

  IF v_state.killed THEN
    RAISE EXCEPTION 'Boss is already dead; its HP can no longer change';
  END IF;

  v_dealt := v_state.max_hp - v_state.hp;
  IF p_max_hp <= v_dealt THEN
    RAISE EXCEPTION 'Players have already dealt % damage; HP must be higher', round(v_dealt);
  END IF;

  UPDATE public.boss_state
     SET max_hp = p_max_hp,
         hp     = p_max_hp - v_dealt
   WHERE event_id = p_event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.admin_set_boss_hp(uuid, real)
  FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Point the weekly cron at the wrapper. Same unschedule-then-schedule guard
-- as 00074.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'spawn-boss-fight') THEN
    PERFORM cron.unschedule('spawn-boss-fight');
  END IF;

  PERFORM cron.schedule(
    'spawn-boss-fight',
    '0 0 * * 4',
    $cron$ SELECT public.spawn_scheduled_boss_fight(); $cron$
  );
END;
$$;
