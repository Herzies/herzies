-- /api/lookup was an N+1: for each of up to 50 friend codes it ran a separate
-- top-artists, last-played and global-rank query. top-artists was the worst —
-- it paged that user's ENTIRE listen_log 1000 rows at a time and tallied the
-- artists in JavaScript, so a full friend list transferred every friend's whole
-- listening history over the wire on every 15s poll. The client's own comment
-- measured the endpoint at 2-3s.
--
-- These three functions replace 4xN queries with 3, each aggregating in
-- Postgres and taking the whole batch of user ids at once.
--
-- SECURITY: top_artists_for_users and last_played_for_users expose listening
-- data, which is private to friends (see the visibility check in the route).
-- They are SECURITY DEFINER and must only ever be reachable by the service
-- role, so EXECUTE is revoked from PUBLIC as well as anon/authenticated —
-- 00052 is the cautionary tale for revoking from only the latter two.

-- Top artists per user, ranked by play count. Replaces the JS tally.
--
-- Two deliberate behaviour changes from the JS version:
--
-- 1. Ties break on artist_name. The old code sorted Object.entries() by count
--    alone, so equal-count artists came out in first-seen order.
-- 2. Blank artist names are excluded. Some listen_log rows land with an empty
--    artist (a player reporting a track with no artist metadata), and on real
--    data those are frequent enough to take the #1 and #2 slots for some
--    users. ProfileView already drops them on render ("they'd otherwise render
--    as a blank, rankless row"), so they were silently costing a user one or
--    two of their three displayed artists.
CREATE OR REPLACE FUNCTION public.top_artists_for_users(
  p_user_ids uuid[],
  p_limit int DEFAULT 3
)
RETURNS TABLE(user_id uuid, artist_name text, plays int) AS $$
  SELECT t.user_id, t.artist_name, t.plays
  FROM (
    SELECT
      l.user_id,
      l.artist_name,
      count(*)::int AS plays,
      row_number() OVER (
        PARTITION BY l.user_id
        ORDER BY count(*) DESC, l.artist_name
      ) AS rn
    FROM public.listen_log l
    WHERE l.user_id = ANY(p_user_ids)
      AND coalesce(btrim(l.artist_name), '') <> ''
    GROUP BY l.user_id, l.artist_name
  ) t
  WHERE t.rn <= p_limit;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '';

-- Most recent track per user. DISTINCT ON is why this is an RPC and not a
-- PostgREST query — there is no way to express "latest row per user" in the
-- REST API without one request per user, which is the N+1 being removed.
CREATE OR REPLACE FUNCTION public.last_played_for_users(p_user_ids uuid[])
RETURNS TABLE(
  user_id uuid,
  track_name text,
  artist_name text,
  listened_at timestamptz,
  album_art_url text
) AS $$
  SELECT DISTINCT ON (l.user_id)
    l.user_id, l.track_name, l.artist_name, l.listened_at, l.album_art_url
  FROM public.listen_log l
  WHERE l.user_id = ANY(p_user_ids)
  ORDER BY l.user_id, l.listened_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '';

-- Global XP rank and total herzie count, for a batch of users in one pass.
--
-- rank() reproduces the old count(xp > mine) + 1 exactly, ties included: both
-- give equal-XP herzies the same rank and then skip (1, 2, 2, 4). count(*)
-- OVER () is the same total the old head/count=exact query returned.
CREATE OR REPLACE FUNCTION public.herzie_ranks(p_user_ids uuid[])
RETURNS TABLE(user_id uuid, global_rank int, global_total int) AS $$
  WITH ranked AS (
    SELECT
      h.user_id,
      rank() OVER (ORDER BY h.xp DESC) AS r,
      count(*) OVER () AS total
    FROM public.herzies h
  )
  SELECT ranked.user_id, ranked.r::int, ranked.total::int
  FROM ranked
  WHERE ranked.user_id = ANY(p_user_ids);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.top_artists_for_users(uuid[], int)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.last_played_for_users(uuid[])
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.herzie_ranks(uuid[])
  FROM PUBLIC, anon, authenticated;
