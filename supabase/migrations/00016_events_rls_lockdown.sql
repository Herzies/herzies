-- Lock down public reads on the events table.
--
-- The previous policy ("Events are publicly readable", using true) allowed
-- anyone with the anon key to SELECT full rows directly via PostgREST,
-- including config.trackTitle / config.trackArtist for song_hunt events —
-- defeating the API-level filtering in /api/events/active. Cheaters used
-- this to read the answer.
--
-- Service role bypasses RLS, so /api/events/active (which uses the admin
-- client) keeps working.

drop policy if exists "Events are publicly readable" on public.events;

revoke select on public.events from anon, authenticated;
