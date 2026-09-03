-- Add album art URL to listen_log, so "last played" on a herzie's profile
-- can show a thumbnail (matching the "now playing" widget's Last.fm-sourced
-- artwork). Never the local device's system artwork data: URL — only the
-- small, remote Last.fm URL is synced (see sync's zod schema).
alter table public.listen_log
  add column if not exists album_art_url text;
