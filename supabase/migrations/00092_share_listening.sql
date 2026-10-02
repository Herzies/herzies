-- "Share what you're listening to" privacy setting.
--
-- When off, /api/lookup withholds the herzie's now playing, last played and
-- top artists from friends, and only tells them whether the herzie is
-- listening right now. Sync keeps writing now_playing regardless: XP, drops
-- and event matching all run off it, and so does that "listening" dot.
alter table public.herzies
  add column if not exists share_listening boolean not null default true;
