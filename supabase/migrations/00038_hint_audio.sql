-- Audio hints for Song Hunt: private storage bucket + per-user play counter.
--
-- Clips are uploaded by admins (service role) and never exposed to clients
-- directly — playback goes through /api/events/hint-audio/play, which mints
-- a short-lived signed URL and atomically increments a play counter capped
-- at 3 plays/user/clip. No RLS policy is added for anon/authenticated on
-- either the bucket or the counter table: only the service role touches
-- them, same lockdown pattern as public.events (00016_events_rls_lockdown.sql).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'hint-audio',
  'hint-audio',
  false,
  5242880, -- 5MiB
  array['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm']
)
on conflict (id) do nothing;

create table if not exists public.hint_plays (
  audio_key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  play_count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (audio_key, user_id)
);

alter table public.hint_plays enable row level security;

-- No SELECT/INSERT/UPDATE policies for anon/authenticated = only service
-- role (and the SECURITY DEFINER function below) can touch this table.
revoke all on public.hint_plays from anon, authenticated;

-- Atomically increments the play counter for (audio_key, user_id), capped
-- at p_max_plays. Returns the new play_count, or no row if the cap was
-- already reached — same insert/guard technique as maxClaims enforcement
-- on event_claims.
create or replace function increment_hint_play(p_audio_key text, p_user_id uuid, p_max_plays int)
returns table (play_count int) as $$
begin
  return query
  insert into public.hint_plays (audio_key, user_id, play_count, updated_at)
  values (p_audio_key, p_user_id, 1, now())
  on conflict (audio_key, user_id) do update
    set play_count = public.hint_plays.play_count + 1,
        updated_at = now()
    where public.hint_plays.play_count < p_max_plays
  returning public.hint_plays.play_count;
end;
$$ language plpgsql security definer set search_path = '';

-- Note: REVOKE ... FROM anon, authenticated is not enough on its own —
-- Postgres grants EXECUTE to PUBLIC by default on function creation, and
-- anon/authenticated inherit that through PUBLIC membership regardless of
-- a role-specific revoke. Must revoke from PUBLIC to actually lock it down
-- (this function takes p_user_id as a parameter, so leaving it publicly
-- callable would let anyone burn another player's plays).
revoke execute on function increment_hint_play(text, uuid, int) from public;
