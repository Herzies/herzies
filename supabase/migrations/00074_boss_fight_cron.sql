-- Boss Fight schedules.
--
-- pg_cron rather than Vercel: packages/web/vercel.json is {"crons": []} and
-- the Spotify cron was removed outright because Hobby plans only support
-- daily jobs (see 53f0572, 6c64c86). A weekly spawner has nowhere to live on
-- Vercel, and this project already runs two pg_cron jobs (00026, 00057).
--
-- Every job is a one-line wrapper over a function defined in 00073. That is
-- deliberate: `select public.spawn_boss_fight();` by hand is the only way to
-- test a four-day event without waiting for Thursday, and driving the same
-- function the cron drives means the test exercises the real path.

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'spawn-boss-fight') THEN
    PERFORM cron.unschedule('spawn-boss-fight');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'settle-boss-fight') THEN
    PERFORM cron.unschedule('settle-boss-fight');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'resolve-boss-fight') THEN
    PERFORM cron.unschedule('resolve-boss-fight');
  END IF;

  -- Thursdays 00:00 UTC. spawn_boss_fight() no-ops if one is already live.
  PERFORM cron.schedule(
    'spawn-boss-fight',
    '0 0 * * 4',
    $cron$ SELECT public.spawn_boss_fight(); $cron$
  );

  -- Every minute, like expire-stale-trades: keeps the gap between the killing
  -- blow and the reward landing short enough that it feels immediate.
  PERFORM cron.schedule(
    'settle-boss-fight',
    '* * * * *',
    $cron$ SELECT public.settle_boss_fight(); $cron$
  );

  -- Hourly is enough — nothing depends on the escape being noticed promptly,
  -- and deal_boss_damage already refuses damage past ends_at on its own.
  PERFORM cron.schedule(
    'resolve-boss-fight',
    '0 * * * *',
    $cron$ SELECT public.resolve_boss_fight(); $cron$
  );
END;
$$;
