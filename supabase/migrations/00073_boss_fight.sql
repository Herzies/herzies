-- Boss Fight — the first event type with mutable shared state.
--
-- Every other event is per-user: event_claims is a boolean participation
-- record with unique(event_id, user_id), and nothing in the schema is written
-- by more than one player. A boss has one HP pool that every player writes to
-- concurrently, which is a different problem and needs different machinery.
--
-- See specs/boss-fight.md.

-- Current state of a boss. One row per boss_fight event.
CREATE TABLE IF NOT EXISTS public.boss_state (
  event_id  uuid PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
  hp        real NOT NULL,
  max_hp    real NOT NULL,
  killed    boolean NOT NULL DEFAULT false,
  killed_at timestamptz,
  settled   boolean NOT NULL DEFAULT false,
  escaped   boolean NOT NULL DEFAULT false,
  CONSTRAINT boss_state_hp_non_negative CHECK (hp >= 0),
  -- A boss cannot both die and get away.
  CONSTRAINT boss_state_not_both CHECK (NOT (killed AND escaped))
);

-- Accumulating per-user contribution. This cannot live on event_claims: that
-- table's unique(event_id, user_id) is what makes claiming race-safe, and it
-- would reject every hit after a player's first.
CREATE TABLE IF NOT EXISTS public.boss_damage (
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  damage   real NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_boss_damage_leaderboard
  ON public.boss_damage (event_id, damage DESC);

-- Same lockdown as events (00016): clients never read boss tables directly,
-- only through service-role API layers that project fields explicitly.
ALTER TABLE public.boss_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.boss_damage ENABLE ROW LEVEL SECURITY;
REVOKE SELECT ON public.boss_state FROM anon, authenticated;
REVOKE SELECT ON public.boss_damage FROM anon, authenticated;


-- ---------------------------------------------------------------------------
-- deal_boss_damage — the only way HP ever moves.
--
-- Takes the row lock BEFORE reading, so concurrent players serialize. The
-- write that crosses zero sets killed = true in the same statement and is the
-- only caller that sees is_killing_blow = true, no matter how many players
-- sync in the same second.
--
-- Read-modify-write here would double-fire rewards. checkSecretTrackEvents
-- already has that shape (COUNT then INSERT) and is saved only by a unique
-- constraint; a boss has no equivalent constraint to hide behind.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deal_boss_damage(
  p_event_id uuid,
  p_user_id  uuid,
  p_damage   real
)
RETURNS TABLE (hp real, is_killing_blow boolean) AS $$
DECLARE
  v_hp     real;
  v_killed boolean;
  v_new_hp real;
  v_now    timestamptz := now();
BEGIN
  IF p_damage IS NULL OR p_damage <= 0 THEN
    RETURN;
  END IF;

  -- Serializes every concurrent hit on this boss.
  SELECT bs.hp, bs.killed
    INTO v_hp, v_killed
    FROM public.boss_state bs
   WHERE bs.event_id = p_event_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Already dead, or the window closed. Damage is dropped, not queued.
  IF v_killed OR v_hp <= 0 THEN
    RETURN QUERY SELECT v_hp, false;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.events e
     WHERE e.id = p_event_id
       AND e.type = 'boss_fight'
       AND e.active
       AND e.starts_at <= v_now
       AND e.ends_at > v_now
  ) THEN
    RETURN QUERY SELECT v_hp, false;
    RETURN;
  END IF;

  INSERT INTO public.boss_damage (event_id, user_id, damage)
  VALUES (p_event_id, p_user_id, p_damage)
  ON CONFLICT (event_id, user_id)
  DO UPDATE SET damage = public.boss_damage.damage + excluded.damage;

  v_new_hp := GREATEST(0, v_hp - p_damage);

  UPDATE public.boss_state bs
     SET hp        = v_new_hp,
         killed    = (v_new_hp <= 0),
         killed_at = CASE WHEN v_new_hp <= 0 THEN v_now ELSE bs.killed_at END
   WHERE bs.event_id = p_event_id;

  -- We held the lock and confirmed NOT killed above, so if it is dead now,
  -- this call is unambiguously the one that killed it.
  RETURN QUERY SELECT v_new_hp, (v_new_hp <= 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.deal_boss_damage(uuid, uuid, real)
  FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- boss_leaderboard — top damage dealers, mirroring top_song_hunt_winners.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.boss_leaderboard(
  p_event_id uuid,
  p_limit    int DEFAULT 5
)
RETURNS TABLE (user_id uuid, name text, damage real, rank bigint) AS $$
  SELECT bd.user_id,
         h.name,
         bd.damage,
         row_number() OVER (ORDER BY bd.damage DESC, bd.user_id)
    FROM public.boss_damage bd
    JOIN public.herzies h ON h.user_id = bd.user_id
   WHERE bd.event_id = p_event_id
     AND bd.damage > 0
   ORDER BY bd.damage DESC, bd.user_id
   LIMIT p_limit;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.boss_leaderboard(uuid, int)
  FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- settle_boss_fight — pays out killed bosses. Safe to run any number of times.
--
-- Deliberately NOT done by the killing blow. That would run N grants inside
-- one unlucky player's /sync request; a timeout halfway through would leave
-- some players paid, some not, killed already true, and nothing to retry.
--
-- The event_claims row IS the "already paid" ledger — its unique constraint
-- is what makes re-running this a no-op for anyone already settled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_boss_fight(p_event_id uuid DEFAULT NULL)
RETURNS int AS $$
DECLARE
  v_event      record;
  v_participant record;
  v_config     jsonb;
  v_base_item  text;
  v_top_item   text;
  v_top_count  int;
  v_paid       int := 0;
BEGIN
  FOR v_event IN
    SELECT e.id, e.config
      FROM public.events e
      JOIN public.boss_state bs ON bs.event_id = e.id
     WHERE e.type = 'boss_fight'
       AND bs.killed
       AND NOT bs.settled
       AND (p_event_id IS NULL OR e.id = p_event_id)
  LOOP
    v_config    := v_event.config;
    v_base_item := v_config ->> 'rewardItemId';
    v_top_item  := v_config ->> 'topRewardItemId';
    v_top_count := COALESCE((v_config ->> 'topCount')::int, 3);

    FOR v_participant IN
      SELECT bd.user_id,
             row_number() OVER (ORDER BY bd.damage DESC, bd.user_id) AS rnk
        FROM public.boss_damage bd
       WHERE bd.event_id = v_event.id
         AND bd.damage > 0
    LOOP
      INSERT INTO public.event_claims (event_id, user_id)
      VALUES (v_event.id, v_participant.user_id)
      ON CONFLICT (event_id, user_id) DO NOTHING;

      -- Conflict means this player was already paid on an earlier run.
      IF NOT FOUND THEN
        CONTINUE;
      END IF;

      IF v_base_item IS NOT NULL THEN
        PERFORM public.grant_inventory_item(v_participant.user_id, v_base_item, 1);
      END IF;

      -- Top dealers get the base item AND the rarer one.
      IF v_top_item IS NOT NULL AND v_participant.rnk <= v_top_count THEN
        PERFORM public.grant_inventory_item(v_participant.user_id, v_top_item, 1);
      END IF;

      v_paid := v_paid + 1;
    END LOOP;

    UPDATE public.boss_state SET settled = true WHERE event_id = v_event.id;
    UPDATE public.events SET active = false WHERE id = v_event.id;
  END LOOP;

  RETURN v_paid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.settle_boss_fight(uuid)
  FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- resolve_boss_fight — the boss got away. No reward, by design.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_boss_fight()
RETURNS int AS $$
DECLARE
  v_count int;
BEGIN
  WITH expired AS (
    UPDATE public.boss_state bs
       SET escaped = true
      FROM public.events e
     WHERE e.id = bs.event_id
       AND e.type = 'boss_fight'
       AND e.ends_at <= now()
       AND NOT bs.killed
       AND NOT bs.escaped
    RETURNING bs.event_id
  )
  SELECT count(*) INTO v_count FROM expired;

  UPDATE public.events e
     SET active = false
    FROM public.boss_state bs
   WHERE bs.event_id = e.id
     AND e.type = 'boss_fight'
     AND bs.escaped
     AND e.active;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.resolve_boss_fight()
  FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- spawn_boss_fight — Thursday 00:00 UTC through end of Sunday.
--
-- Parameters exist so the same function the cron calls can also be driven by
-- hand for testing; with no arguments it behaves exactly as the cron does.
-- A four-day event on a weekly schedule is otherwise untestable in under a
-- week, and a separate test-only spawn path would not be testing this one.
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
  v_genres    text[];
  v_active    int;
  v_hp        real;
  v_starts_at timestamptz := now();
  v_ends_at   timestamptz;
  v_event_id  uuid;
BEGIN
  -- No-op if a boss is already live. Without this a hand-run during testing,
  -- or a cron retry, produces two live bosses and "the active boss" stops
  -- being a well-defined thing.
  IF EXISTS (
    SELECT 1 FROM public.events e
     WHERE e.type = 'boss_fight'
       AND e.active
       AND e.ends_at > now()
  ) THEN
    RETURN NULL;
  END IF;

  v_genres := COALESCE(
    p_hated_genres,
    ARRAY(SELECT unnest(v_pool) ORDER BY random() LIMIT 3)
  );

  -- Four days: Thursday 00:00 UTC to Monday 00:00 UTC, leaving Mon-Wed free
  -- for other event types.
  v_ends_at := COALESCE(p_ends_at, v_starts_at + interval '4 days');

  SELECT count(*) INTO v_active
    FROM public.herzies h
   WHERE h.last_synced_at > now() - interval '7 days';

  -- 35 damage-minutes per active player over the four-day window. The floor
  -- matters more than the ceiling at current player counts: an oversized boss
  -- always escapes, and the event never pays out.
  v_hp := COALESCE(p_hp, LEAST(50000, GREATEST(900, v_active * 35.0)));

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
      'rewardItemId',    'cd',
      'topRewardItemId', 'cd',
      'topCount',        3,
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
