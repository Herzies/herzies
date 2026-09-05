-- Song hunt leaderboard: top herzies by number of song hunts won. Mirrors
-- count_song_hunt_wins's derivation from event_claims (no persisted counter),
-- but aggregated across all users instead of one.

CREATE OR REPLACE FUNCTION public.top_song_hunt_winners(p_limit int DEFAULT 100)
RETURNS TABLE(user_id uuid, wins int) AS $$
  SELECT ec.user_id, count(*)::int AS wins
  FROM public.event_claims ec
  JOIN public.events e ON e.id = ec.event_id
  WHERE e.type = 'song_hunt'
  GROUP BY ec.user_id
  ORDER BY wins DESC
  LIMIT p_limit;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '';
