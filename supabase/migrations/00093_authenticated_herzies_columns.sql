-- Close the logged-in half of the listening privacy hole.
--
-- 00021 limited anon to the public leaderboard columns, but authenticated
-- kept Supabase's default table-wide SELECT, and the "Public friend lookup"
-- policy is using(true). So any signed-in user could read every herzie's
-- now_playing (and friend list, inventory, currency, …) straight from
-- PostgREST, which made "Share what you're listening to" (00092) cosmetic.
--
-- Nothing reads herzies with a user's JWT except the web leaderboard, which
-- only needs these columns. Everything else goes through the service role
-- (Next.js routes, edge functions) or security-definer functions (the chat and
-- trade broadcast triggers), which neither RLS nor these grants affect.
revoke select on public.herzies from authenticated;
grant select (
  name,
  stage,
  level,
  xp,
  appearance,
  total_minutes_listened,
  genre_minutes
) on public.herzies to authenticated;
