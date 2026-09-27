-- Let the admin delete a series occurrence for good.
--
-- Until now deleting an upcoming occurrence was pointless: its slot had no
-- row any more, so the next hourly materialize_event_series run wrote it
-- straight back. The admin page hid the delete button for that reason and
-- offered "skip" instead, which left no way to remove a duplicate outright.
--
-- An exclusion records "this slot was removed on purpose". The admin DELETE
-- route writes one before deleting an occurrence; regenerating a series after
-- an edit deletes rows directly and writes none, so those slots do come back.

CREATE TABLE IF NOT EXISTS public.event_series_exclusions (
  series_id     uuid NOT NULL REFERENCES public.event_series(id) ON DELETE CASCADE,
  occurrence_at timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, occurrence_at)
);

ALTER TABLE public.event_series_exclusions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_series_exclusions FROM anon, authenticated;

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
      -- Deleted on purpose by the admin: never bring it back.
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.event_series_exclusions x
         WHERE x.series_id = v_series.id AND x.occurrence_at = v_at
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
