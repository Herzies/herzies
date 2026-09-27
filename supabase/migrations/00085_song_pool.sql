-- A pool of songs for future song hunts.
--
-- The admin adds candidates (from the admin page, or by asking the curator in
-- chat); the weekly curator routine picks from whatever is unused and only
-- chooses a song itself once the pool runs dry.
--
-- There is deliberately no "used" column: a pool entry counts as used as soon
-- as any song_hunt event has it as its answer (compared the way the game
-- matches plays, case-insensitively). That covers hunts the routine proposed
-- and hunts the admin curated by hand, with nothing to keep in sync.
CREATE TABLE IF NOT EXISTS public.song_pool (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_title  text NOT NULL CHECK (btrim(track_title) <> ''),
  track_artist text NOT NULL CHECK (btrim(track_artist) <> ''),
  -- Optional pointers for the clue writer ("the video is one long take").
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS song_pool_track_key
  ON public.song_pool (lower(btrim(track_artist)), lower(btrim(track_title)));

ALTER TABLE public.song_pool ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.song_pool FROM anon, authenticated;
