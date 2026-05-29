-- Listening privacy hardening.
--
-- Previously the anon role could SELECT every column of `herzies` (via the
-- "Public friend lookup" using(true) policy + a table-wide SELECT grant) and
-- every row of `listen_log` (via a public read policy). That exposed each
-- user's currently-playing track, full listening history, and other private
-- columns to anyone holding the public anon key.
--
-- After this migration:
--   * anon can only read the columns the public leaderboard needs from
--     `herzies` — never `now_playing`, friend lists, inventory, currency, etc.
--   * `listen_log` is readable only by its owner.
--   * The game server (service_role) bypasses RLS and column grants, so the
--     authenticated, friend-gated /api/lookup endpoint still serves friends'
--     listening data.

-- 1. herzies: restrict anon to the public leaderboard columns only.
revoke select on public.herzies from anon;
grant select (
  name,
  stage,
  level,
  xp,
  appearance,
  total_minutes_listened,
  genre_minutes
) on public.herzies to anon;

-- 2. listen_log: drop the public read policy and restrict reads to the owner.
drop policy if exists "Listen log is publicly readable" on public.listen_log;

drop policy if exists "Users can read own listen_log" on public.listen_log;
create policy "Users can read own listen_log"
  on public.listen_log for select
  to authenticated
  using (auth.uid() = user_id);
