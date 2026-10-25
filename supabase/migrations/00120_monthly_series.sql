-- Monthly event series, for a Tower that starts over every month.
--
-- A series could only repeat every N days, so "the 1st of every month" was
-- out of reach (months run 28 to 31 days). Two additions:
--
-- - interval_months: repeat every N calendar months instead (interval_days
--   is then ignored). Slots are the anchor plus k*N months, in UTC, always
--   counted from the anchor (stepping month by month would turn Jan 31 into
--   Feb 28 and then Mar 28). The admin API keeps monthly anchors on days
--   1-28.
-- - duration_minutes NULL: each occurrence runs until the next one starts,
--   back to back. Only with interval_months; a day-based series still needs
--   a length.
--
-- A Tower's best floors are kept per event (tower_progress, 00115), so a new
-- occurrence each month is a fresh climb; the old ones stay for the all-time
-- board.

ALTER TABLE public.event_series
  ADD COLUMN IF NOT EXISTS interval_months int CHECK (interval_months > 0);

ALTER TABLE public.event_series
  ALTER COLUMN duration_minutes DROP NOT NULL;

ALTER TABLE public.event_series DROP CONSTRAINT IF EXISTS event_series_duration_check;
ALTER TABLE public.event_series
  ADD CONSTRAINT event_series_duration_check
  CHECK (duration_minutes IS NOT NULL OR interval_months IS NOT NULL);

-- ---------------------------------------------------------------------------
-- event_series_slot — the k-th slot of a series (k from 0): its start.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.event_series_slot(
  p_series public.event_series,
  p_k      int
)
RETURNS timestamptz AS $$
  SELECT CASE
    WHEN p_series.interval_months IS NOT NULL THEN
      ((p_series.anchor_at AT TIME ZONE 'UTC')
        + make_interval(months => p_k * p_series.interval_months))
        AT TIME ZONE 'UTC'
    ELSE
      p_series.anchor_at + make_interval(days => p_k * p_series.interval_days)
  END;
$$ LANGUAGE sql STABLE SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.event_series_slot(public.event_series, int)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- materialize_event_series — as in 00084, with monthly slots and
-- back-to-back occurrences. Every check that used the slot's end (the
-- ended-slot skip, the overlap test, the row's ends_at) now uses v_end.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.materialize_event_series(
  p_horizon   interval DEFAULT interval '28 days',
  p_series_id uuid     DEFAULT NULL
)
RETURNS int AS $$
DECLARE
  v_series  public.event_series%ROWTYPE;
  v_now     timestamptz := now();
  v_k       int;
  v_at      timestamptz;
  v_end     timestamptz;
  v_months  int;
  v_created int := 0;
  v_id      uuid;
BEGIN
  FOR v_series IN
    SELECT * FROM public.event_series s
     WHERE s.enabled
       AND (p_series_id IS NULL OR s.id = p_series_id)
  LOOP
    -- First slot that could still be running: jump straight there rather
    -- than walking from an anchor that may be months old. One slot early
    -- (a back-to-back slot runs a whole interval), clamped at 0.
    IF v_series.interval_months IS NOT NULL THEN
      v_months :=
        (extract(year FROM v_now AT TIME ZONE 'UTC')
          - extract(year FROM v_series.anchor_at AT TIME ZONE 'UTC'))::int * 12
        + (extract(month FROM v_now AT TIME ZONE 'UTC')
          - extract(month FROM v_series.anchor_at AT TIME ZONE 'UTC'))::int;
      v_k := GREATEST(0, v_months / v_series.interval_months - 1);
    ELSE
      v_k := GREATEST(0, floor(
        extract(epoch FROM (
          v_now
          - make_interval(mins => v_series.duration_minutes)
          - v_series.anchor_at))
        / extract(epoch FROM make_interval(days => v_series.interval_days))
      )::int);
    END IF;

    LOOP
      v_at  := public.event_series_slot(v_series, v_k);
      v_end := CASE
        WHEN v_series.duration_minutes IS NULL
          THEN public.event_series_slot(v_series, v_k + 1)
        ELSE v_at + make_interval(mins => v_series.duration_minutes)
      END;
      v_k := v_k + 1;
      EXIT WHEN v_at > v_now + p_horizon;
      EXIT WHEN v_series.until IS NOT NULL AND v_at >= v_series.until;
      CONTINUE WHEN v_end <= v_now;
      -- Either this exact slot already has a row, or an occurrence this
      -- series kept (hand-edited, skipped, or moved) already covers the time:
      -- after an admin shifts the schedule, the kept rows from the old one
      -- must not be doubled up by fresh ones a few hours away.
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.events e
         WHERE e.series_id = v_series.id
           AND (e.occurrence_at = v_at
                OR (e.starts_at < v_end AND e.ends_at > v_at))
      );
      -- Deleted on purpose by the admin: never bring it back.
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.event_series_exclusions x
         WHERE x.series_id = v_series.id AND x.occurrence_at = v_at
      );

      IF v_series.type = 'boss_fight' THEN
        v_id := public.create_boss_event(
          v_series.title, v_series.description, v_at, v_end,
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
          v_end,
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
