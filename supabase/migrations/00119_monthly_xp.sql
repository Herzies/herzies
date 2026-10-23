-- XP gained per calendar month (UTC), for the monthly leaderboard.
--
-- herzies.xp is cumulative and written from several places (sync, the tower,
-- skill effects, ...), so rather than touch each, a trigger adds every gain
-- to the current month's row. Starts empty: there is no history to backfill
-- from (listen_log can't reproduce bonus XP).

create table if not exists public.herzie_xp_monthly (
  user_id uuid not null references auth.users(id) on delete cascade,
  month date not null,
  xp bigint not null default 0,
  primary key (user_id, month)
);

create index if not exists idx_herzie_xp_monthly_month
  on public.herzie_xp_monthly (month, xp desc);

-- Read through the service role only (the leaderboard API).
alter table public.herzie_xp_monthly enable row level security;
revoke all on public.herzie_xp_monthly from anon, authenticated;

create or replace function public.track_monthly_xp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.herzie_xp_monthly (user_id, month, xp)
  values (
    new.user_id,
    date_trunc('month', now() at time zone 'utc')::date,
    new.xp - old.xp
  )
  on conflict (user_id, month)
  do update set xp = public.herzie_xp_monthly.xp + excluded.xp;
  return null;
end;
$$;

revoke execute on function public.track_monthly_xp() from public, anon, authenticated;

drop trigger if exists herzies_track_monthly_xp on public.herzies;
create trigger herzies_track_monthly_xp
  after update of xp on public.herzies
  for each row
  when (new.xp > old.xp)
  execute function public.track_monthly_xp();
