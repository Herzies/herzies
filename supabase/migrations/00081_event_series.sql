-- Recurring events: series that materialize into ordinary `events` rows, and
-- Good ol' George, a merchant event that sells admin-chosen items.
--
-- A series never goes live itself. materialize_event_series() writes each
-- upcoming slot out as a normal events row (an "occurrence") a few weeks
-- ahead, and from then on that row is the thing an admin edits, skips or
-- deletes. Every reader of `events` keeps filtering on `active` + the time
-- window exactly as before; nothing downstream knows series exist.
--
-- Occurrences that need hand curation (a song hunt's track and hints, George's
-- stock) are materialized with active = false and only go live once the admin
-- fills them in — an uncurated hunt must never reach players.
--
-- Replaces the hardcoded Thursday boss cron and its settings/skips tables
-- (00074, 00076) with a seeded weekly boss series.

-- ---------------------------------------------------------------------------
-- Series
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_series (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text NOT NULL CHECK (type IN ('song_hunt', 'boss_fight', 'merchant')),
  title            text NOT NULL,
  description      text,
  enabled          boolean NOT NULL DEFAULT true,
  -- The first occurrence's start. Its weekday and UTC time are the schedule.
  anchor_at        timestamptz NOT NULL,
  interval_days    int NOT NULL DEFAULT 7 CHECK (interval_days > 0),
  duration_minutes int NOT NULL CHECK (duration_minutes > 0),
  -- No occurrence starts at or after this.
  until            timestamptz,
  -- Copied into each occurrence's config when it is materialized.
  config_template  jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.event_series ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_series FROM anon, authenticated;

-- occurrence_at is the slot the series generated, and never moves even when
-- an admin drags the occurrence's own window around. It is what makes
-- re-materializing a no-op for a slot that already has a row — skipped,
-- edited or untouched.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS series_id     uuid REFERENCES public.event_series(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS occurrence_at timestamptz,
  ADD COLUMN IF NOT EXISTS skipped       boolean NOT NULL DEFAULT false,
  -- Set once an admin edits an occurrence. Editing the series regenerates
  -- only future occurrences nobody has touched.
  ADD COLUMN IF NOT EXISTS customized    boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS events_series_occurrence_key
  ON public.events (series_id, occurrence_at);


-- ---------------------------------------------------------------------------
-- event_config_complete — whether an occurrence has what it needs to go live.
-- Mirrored by isEventConfigComplete in the admin API; keep the two together.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.event_config_complete(p_type text, p_config jsonb)
RETURNS boolean AS $$
  SELECT CASE p_type
    WHEN 'song_hunt' THEN
      coalesce(p_config ->> 'trackTitle', '') <> ''
      AND coalesce(p_config ->> 'trackArtist', '') <> ''
      AND jsonb_typeof(p_config -> 'hints') = 'array'
      AND jsonb_array_length(p_config -> 'hints') > 0
    WHEN 'merchant' THEN
      jsonb_typeof(p_config -> 'stock') = 'array'
      AND jsonb_array_length(p_config -> 'stock') > 0
    ELSE true
  END;
$$ LANGUAGE sql IMMUTABLE SET search_path = '';


-- ---------------------------------------------------------------------------
-- create_boss_event — one boss: the event row plus its boss_state HP pool.
--
-- Shared by the series materializer and spawn_boss_fight (kept for tests and
-- hand spawning). Refuses (returns NULL) if any active boss overlaps the
-- window: sync_context picks "the" active boss, so there may only be one.
--
-- Template keys, all optional: hatedGenres, maxHp, rewardItemId,
-- topRewardItemId, topCount.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_boss_event(
  p_title         text,
  p_description   text,
  p_starts_at     timestamptz,
  p_ends_at       timestamptz,
  p_template      jsonb DEFAULT '{}',
  p_series_id     uuid DEFAULT NULL,
  p_occurrence_at timestamptz DEFAULT NULL
)
RETURNS uuid AS $$
DECLARE
  -- GENRES minus 'pop'. Pop is the fallback for every unmatched Last.fm tag,
  -- for the Spotify path, and for a Last.fm timeout — a boss that hated pop
  -- would take damage from essentially every listen in the game.
  v_pool     text[] := ARRAY[
    'rock','hip-hop','electronic','jazz','classical','r&b','country',
    'metal','indie','latin','folk','blues','punk','soul'
  ];
  v_template jsonb := coalesce(p_template, '{}');
  v_genres   jsonb;
  v_active   int;
  v_hp       real;
  v_event_id uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.events e
     WHERE e.type = 'boss_fight'
       AND e.active
       AND e.starts_at < p_ends_at
       AND e.ends_at > p_starts_at
  ) THEN
    RETURN NULL;
  END IF;

  v_genres := CASE
    WHEN jsonb_typeof(v_template -> 'hatedGenres') = 'array'
         AND jsonb_array_length(v_template -> 'hatedGenres') > 0
      THEN v_template -> 'hatedGenres'
    ELSE to_jsonb(ARRAY(SELECT unnest(v_pool) ORDER BY random() LIMIT 3))
  END;

  SELECT count(*) INTO v_active
    FROM public.herzies h
   WHERE h.last_synced_at > now() - interval '7 days';

  -- 35 damage-minutes per active player over a four-day window. The floor
  -- matters more than the ceiling at current player counts: an oversized boss
  -- always escapes, and the event never pays out.
  v_hp := coalesce(
    nullif(v_template ->> 'maxHp', '')::real,
    LEAST(50000, GREATEST(900, v_active * 35.0))
  );

  INSERT INTO public.events (
    type, title, description, active, starts_at, ends_at, config,
    series_id, occurrence_at
  )
  VALUES (
    'boss_fight',
    p_title,
    p_description,
    true,
    p_starts_at,
    p_ends_at,
    jsonb_strip_nulls(jsonb_build_object(
      'hatedGenres',     v_genres,
      'rewardItemId',    coalesce(v_template ->> 'rewardItemId', 'cd'),
      'topRewardItemId', CASE WHEN v_template ? 'topRewardItemId'
                              THEN v_template ->> 'topRewardItemId'
                              ELSE 'cd' END,
      'topCount',        coalesce((v_template ->> 'topCount')::int, 3),
      'maxHp',           v_hp
    )),
    p_series_id,
    p_occurrence_at
  )
  RETURNING id INTO v_event_id;

  INSERT INTO public.boss_state (event_id, hp, max_hp)
  VALUES (v_event_id, v_hp, v_hp);

  RETURN v_event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.create_boss_event(text, text, timestamptz, timestamptz, jsonb, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- spawn_boss_fight — same signature as 00073/00076, now a thin wrapper. Kept
-- so a boss can still be spawned by hand and so the boss tests keep driving
-- the real creation path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.spawn_boss_fight(
  p_hated_genres text[]      DEFAULT NULL,
  p_hp           real        DEFAULT NULL,
  p_ends_at      timestamptz DEFAULT NULL,
  p_title        text        DEFAULT NULL
)
RETURNS uuid AS $$
BEGIN
  RETURN public.create_boss_event(
    coalesce(p_title, 'Nohoot Henry'),
    'Listen to what it hates.',
    now(),
    coalesce(p_ends_at, now() + interval '4 days'),
    jsonb_strip_nulls(jsonb_build_object(
      'hatedGenres', to_jsonb(p_hated_genres),
      'maxHp',       p_hp
    ))
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.spawn_boss_fight(text[], real, timestamptz, text)
  FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- materialize_event_series — write out every slot that ends in the future and
-- starts within the horizon. Safe to run any number of times.
--
-- Slots that already have a row are left alone whatever state it is in, which
-- is what makes skipping and hand edits stick; so are slots overlapping any
-- occurrence the series already has. A slot that ended before it was
-- ever materialized is not backfilled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.materialize_event_series(
  p_horizon   interval DEFAULT interval '28 days',
  p_series_id uuid     DEFAULT NULL
)
RETURNS int AS $$
DECLARE
  v_series  public.event_series%ROWTYPE;
  v_now     timestamptz := now();
  v_step    interval;
  v_dur     interval;
  v_k       int;
  v_at      timestamptz;
  v_created int := 0;
  v_id      uuid;
BEGIN
  FOR v_series IN
    SELECT * FROM public.event_series s
     WHERE s.enabled
       AND (p_series_id IS NULL OR s.id = p_series_id)
  LOOP
    v_step := make_interval(days => v_series.interval_days);
    v_dur  := make_interval(mins => v_series.duration_minutes);
    -- First slot that could still be running: jump straight there rather than
    -- walking from an anchor that may be months old.
    v_k := GREATEST(0, floor(
      extract(epoch FROM (v_now - v_dur - v_series.anchor_at))
      / extract(epoch FROM v_step)
    )::int);

    LOOP
      v_at := v_series.anchor_at + v_step * v_k;
      v_k  := v_k + 1;
      EXIT WHEN v_at > v_now + p_horizon;
      EXIT WHEN v_series.until IS NOT NULL AND v_at >= v_series.until;
      CONTINUE WHEN v_at + v_dur <= v_now;
      -- Either this exact slot already has a row, or an occurrence this
      -- series kept (hand-edited, skipped, or moved) already covers the time:
      -- after an admin shifts the schedule, the kept rows from the old one
      -- must not be doubled up by fresh ones a few hours away.
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.events e
         WHERE e.series_id = v_series.id
           AND (e.occurrence_at = v_at
                OR (e.starts_at < v_at + v_dur AND e.ends_at > v_at))
      );

      IF v_series.type = 'boss_fight' THEN
        v_id := public.create_boss_event(
          v_series.title, v_series.description, v_at, v_at + v_dur,
          v_series.config_template, v_series.id, v_at
        );
        IF v_id IS NOT NULL THEN
          v_created := v_created + 1;
        END IF;
      ELSE
        INSERT INTO public.events (
          type, title, description, active, starts_at, ends_at, config,
          series_id, occurrence_at
        )
        VALUES (
          v_series.type,
          v_series.title,
          v_series.description,
          public.event_config_complete(v_series.type, v_series.config_template),
          v_at,
          v_at + v_dur,
          v_series.config_template,
          v_series.id,
          v_at
        )
        ON CONFLICT (series_id, occurrence_at) DO NOTHING;
        IF FOUND THEN
          v_created := v_created + 1;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  RETURN v_created;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.materialize_event_series(interval, uuid)
  FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Good ol' George — merchant events.
--
-- config: { "stock": [{ "itemId", "price", "perPlayerLimit"?, "totalStock"? }] }
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.merchant_sales (
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  item_id  text NOT NULL,
  sold     int  NOT NULL DEFAULT 0 CHECK (sold >= 0),
  PRIMARY KEY (event_id, item_id)
);

CREATE TABLE IF NOT EXISTS public.merchant_purchases (
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id  text NOT NULL,
  quantity int  NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  PRIMARY KEY (event_id, user_id, item_id)
);

ALTER TABLE public.merchant_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merchant_purchases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.merchant_sales FROM anon, authenticated;
REVOKE ALL ON public.merchant_purchases FROM anon, authenticated;

-- Same shape as buy_item_units (00079), priced from the event instead of the
-- catalog. The merchant_sales row lock serializes buyers of the same item, so
-- two players racing for the last unit cannot both get it; the herzie lock
-- serializes one player's own buys, which is what the per-player cap needs.
CREATE OR REPLACE FUNCTION public.buy_from_merchant(
  p_user_id  uuid,
  p_event_id uuid,
  p_item_id  text,
  p_quantity int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_entry    jsonb;
  v_price    int;
  v_total    int;
  v_limit    int;
  v_sold     int;
  v_bought   int;
  v_cost     int;
  v_currency int;
BEGIN
  PERFORM 1 FROM public.herzies WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-found');
  END IF;

  IF p_quantity IS NULL OR p_quantity < 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad-quantity');
  END IF;

  SELECT s INTO v_entry
    FROM public.events e,
         jsonb_array_elements(coalesce(e.config -> 'stock', '[]')) s
   WHERE e.id = p_event_id
     AND e.type = 'merchant'
     AND e.active
     AND e.starts_at <= now()
     AND e.ends_at > now()
     AND s ->> 'itemId' = p_item_id
   LIMIT 1;

  IF v_entry IS NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.events e
       WHERE e.id = p_event_id AND e.type = 'merchant' AND e.active
         AND e.starts_at <= now() AND e.ends_at > now()
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not-live');
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'not-sold-here');
  END IF;

  v_price := (v_entry ->> 'price')::int;
  v_total := nullif(v_entry ->> 'totalStock', '')::int;
  v_limit := nullif(v_entry ->> 'perPlayerLimit', '')::int;
  IF v_price IS NULL OR v_price <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-sold-here');
  END IF;

  INSERT INTO public.merchant_sales (event_id, item_id)
  VALUES (p_event_id, p_item_id)
  ON CONFLICT DO NOTHING;

  SELECT sold INTO v_sold
    FROM public.merchant_sales
   WHERE event_id = p_event_id AND item_id = p_item_id
     FOR UPDATE;

  IF v_total IS NOT NULL AND v_sold + p_quantity > v_total THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'sold-out');
  END IF;

  SELECT coalesce(max(quantity), 0) INTO v_bought
    FROM public.merchant_purchases
   WHERE event_id = p_event_id AND user_id = p_user_id AND item_id = p_item_id;

  IF v_limit IS NOT NULL AND v_bought + p_quantity > v_limit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'limit-reached');
  END IF;

  v_cost := v_price * p_quantity;
  SELECT currency INTO v_currency FROM public.herzies WHERE user_id = p_user_id;
  IF v_currency < v_cost THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient-funds');
  END IF;

  UPDATE public.herzies
     SET currency = currency - v_cost
   WHERE user_id = p_user_id
  RETURNING currency INTO v_currency;

  INSERT INTO public.item_units (user_id, item_id)
  SELECT p_user_id, p_item_id FROM generate_series(1, p_quantity);

  UPDATE public.merchant_sales
     SET sold = sold + p_quantity
   WHERE event_id = p_event_id AND item_id = p_item_id;

  INSERT INTO public.merchant_purchases (event_id, user_id, item_id, quantity)
  VALUES (p_event_id, p_user_id, p_item_id, p_quantity)
  ON CONFLICT (event_id, user_id, item_id)
  DO UPDATE SET quantity = public.merchant_purchases.quantity + excluded.quantity;

  RETURN jsonb_build_object(
    'ok', true, 'spent', v_cost, 'newCurrency', v_currency,
    'state', public.item_state(p_user_id));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.buy_from_merchant(uuid, uuid, text, int)
  FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Boss cutover: the weekly cron becomes a series.
--
-- Anchored on the next Thursday rather than backdated, so it cannot collide
-- with a boss already running this week.
-- ---------------------------------------------------------------------------
INSERT INTO public.event_series (
  type, title, description, anchor_at, interval_days, duration_minutes,
  config_template
)
SELECT
  'boss_fight',
  'Nohoot Henry',
  'Listen to what it hates.',
  -- Next Thursday 00:00 UTC strictly after today.
  (date_trunc('week', now() AT TIME ZONE 'utc') + interval '3 days'
    + CASE WHEN extract(isodow FROM now() AT TIME ZONE 'utc') >= 4
           THEN interval '7 days' ELSE interval '0' END) AT TIME ZONE 'utc',
  7,
  4 * 24 * 60,
  jsonb_strip_nulls(jsonb_build_object(
    'maxHp',           s.default_hp,
    'rewardItemId',    coalesce(s.reward_item_id, 'cd'),
    'topRewardItemId', s.top_reward_item_id,
    'topCount',        coalesce(s.top_count, 3)
  ))
FROM (SELECT 1) one
LEFT JOIN public.boss_fight_settings s ON s.id
WHERE NOT EXISTS (SELECT 1 FROM public.event_series WHERE type = 'boss_fight');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'spawn-boss-fight') THEN
    PERFORM cron.unschedule('spawn-boss-fight');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'materialize-event-series') THEN
    PERFORM cron.unschedule('materialize-event-series');
  END IF;

  -- Hourly keeps a four-week horizon topped up; the admin API also runs it
  -- straight after any series change so the calendar never waits for this.
  PERFORM cron.schedule(
    'materialize-event-series',
    '5 * * * *',
    $cron$ SELECT public.materialize_event_series(); $cron$
  );
END;
$$;

DROP FUNCTION IF EXISTS public.spawn_scheduled_boss_fight();
DROP TABLE IF EXISTS public.boss_fight_skips;
DROP TABLE IF EXISTS public.boss_fight_settings;

SELECT public.materialize_event_series();
