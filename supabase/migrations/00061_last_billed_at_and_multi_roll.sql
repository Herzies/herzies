-- Two fixes to the drop cadence, both in processSync's step 4/5.
--
-- 1. BILLING CLOCK. The wall-clock cap and the 8s cooldown that decide how many
--    listened minutes a sync may credit were both measured from
--    `last_synced_at`. But every sync rewrites that column unconditionally — it
--    doubles as a daemon-liveness heartbeat, read by the Spotify cron
--    (packages/web/src/app/api/cron/spotify-sync/route.ts) to skip users the
--    desktop app is already covering. The desktop sync loop ticks every 5s
--    while its window is visible, so the measured gap was permanently under the
--    8s cooldown and *no listening time was ever credited with the window
--    open*. Drop eligibility is a counter diff on total_minutes_listened, so
--    that also meant no drops — the reported symptom. Drops only landed during
--    hidden-window stretches, where the 60s cadence clears the cooldown, which
--    is why they showed up as a pile after a session rather than one every ten
--    minutes.
--
--    `last_billed_at` is the clock those two caps now use. It moves only when
--    minutes were really credited; `last_synced_at` keeps moving on every sync
--    so the cron's liveness check is unaffected.
--
--    sync_context needs no change: it returns to_jsonb(h) over the whole herzie
--    row (00060), so the new column flows through on its own.

ALTER TABLE public.herzies
  ADD COLUMN IF NOT EXISTS last_billed_at timestamptz;

-- Seed from last_synced_at rather than leaving it NULL — a NULL skips the
-- wall-clock cap entirely (see the `if (lastBilledAt)` guard), which would hand
-- every existing user one free uncapped 10-minute bill on their next sync.
UPDATE public.herzies
SET last_billed_at = last_synced_at
WHERE last_billed_at IS NULL;

-- 2. MULTI-ROLL. processSync awarded at most one drop per sync and then
--    fast-forwarded drop_rolls_done all the way to the eligible count, writing
--    off every other roll it owed. Invisible on the desktop path (its minutes
--    are capped at 10 per sync, so it can only ever cross one 10-minute
--    boundary) but the Spotify cron passes uncapped catch-up minutes: a
--    50-minute catch-up paid 1 of the 5 rolls it owed and burned 4.
--
--    Batch insert so a multi-roll catch-up still costs one round trip. The
--    single-item roll_pending_drop stays — debug-spawn-drop uses it.
CREATE OR REPLACE FUNCTION public.roll_pending_drops(p_user_id uuid, p_item_ids text[])
RETURNS void AS $$
  INSERT INTO public.pending_drops (user_id, item_id)
  SELECT p_user_id, unnest(p_item_ids);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = '';

-- CREATE OR REPLACE re-grants EXECUTE to PUBLIC — revoke explicitly for all
-- three roles, same as 00053/00054 (see 00052 for why ordering alone doesn't
-- do it). pending_drops is only ever written through these SECURITY DEFINER
-- functions, called by the service-role admin client.
REVOKE EXECUTE ON FUNCTION public.roll_pending_drops(uuid, text[]) FROM PUBLIC, anon, authenticated;
