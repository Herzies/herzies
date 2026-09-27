-- Fix create_boss_event (00081) always rolling the same hated genres.
--
-- `SELECT unnest(v_pool) ORDER BY random() LIMIT 3` sorts the single input
-- row before the select-list unnest expands it, so the "random" pick was
-- always rock / hip-hop / electronic — the first three of the pool. The same
-- expression lived in spawn_boss_fight since 00073.
--
-- Also rerolls the series bosses that haven't started and nobody has edited:
-- they were all generated with the broken pick, and none can have taken
-- damage yet.

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
    -- unnest in FROM, not in the select list: with a select-list SRF the
    -- sort runs before the array is expanded, so random() is evaluated once
    -- and every boss got the pool's first three genres.
    ELSE to_jsonb(ARRAY(
      SELECT g FROM unnest(v_pool) AS g ORDER BY random() LIMIT 3
    ))
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

UPDATE public.events e
   SET config = jsonb_set(
         e.config,
         '{hatedGenres}',
         to_jsonb(ARRAY(
           SELECT g
             FROM unnest(ARRAY[
               'rock','hip-hop','electronic','jazz','classical','r&b','country',
               'metal','indie','latin','folk','blues','punk','soul'
             ]) AS g
            -- e.id keeps random() per-row rather than hoisted once.
            ORDER BY random() + 0 * length(e.id::text)
            LIMIT 3
         ))
       )
  FROM public.event_series s
 WHERE e.series_id = s.id
   AND e.type = 'boss_fight'
   AND NOT e.customized
   AND e.starts_at > now()
   -- Only rolled genres: a template that names its genres is left alone.
   AND coalesce(jsonb_array_length(
         CASE WHEN jsonb_typeof(s.config_template -> 'hatedGenres') = 'array'
              THEN s.config_template -> 'hatedGenres' END
       ), 0) = 0;
