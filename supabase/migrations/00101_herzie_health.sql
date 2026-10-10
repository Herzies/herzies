-- Herzie health.
--
-- HP is stored lazily: `hp` is the value at `hp_at`, and everything after is
-- computed on read (see packages/shared/src/vitals.ts, which this mirrors —
-- change one, change the other). NULL `hp` means full, so existing herzies
-- need no backfill. `down` is a separate flag because regen would otherwise
-- lift a knocked-out herzie above 0 within seconds, and the respawn button
-- would then have nothing to do: while down, HP is 0 and does not regen
-- until `respawn_herzie` clears it.
--
-- Every write goes through these RPCs (service role only, like the rest of
-- the herzies table): the Town server reports absolute HP for players in a
-- fight, the client asks for a respawn through the `town-vitals` edge
-- function. Nothing here can heal beyond regen, except the capped bench
-- bonus and a respawn.

alter table public.herzies
  add column if not exists hp real,
  add column if not exists hp_at timestamptz,
  add column if not exists down boolean not null default false;

alter table public.herzies
  drop constraint if exists herzies_hp_nonnegative;
alter table public.herzies
  add constraint herzies_hp_nonnegative check (hp is null or hp >= 0);

-- Max HP at a level. Mirrors `maxHp` in vitals.ts.
create or replace function public.herzie_max_hp(p_level integer)
returns real
language sql
immutable
set search_path = ''
as $$
  select (100 + 5 * greatest(coalesce(p_level, 1), 1))::real;
$$;

-- HP at `p_now`: stored value plus regen after the 5s post-write delay, a
-- full bar in about five minutes. Mirrors `effectiveHp` in vitals.ts.
create or replace function public.herzie_effective_hp(
  p_hp real,
  p_hp_at timestamptz,
  p_down boolean,
  p_level integer,
  p_now timestamptz default now()
)
returns real
language sql
immutable
set search_path = ''
as $$
  select case
    when p_down then 0::real
    when p_hp is null or p_hp_at is null then public.herzie_max_hp(p_level)
    else least(
      public.herzie_max_hp(p_level),
      greatest(p_hp, 0)
        + greatest(extract(epoch from (p_now - p_hp_at)) - 5, 0)
          * public.herzie_max_hp(p_level) / 300.0
    )::real
  end;
$$;

-- The vitals as the clients see them. `hpAt` is ms since the epoch.
create or replace function public.herzie_vitals_json(
  p_hp real,
  p_hp_at timestamptz,
  p_down boolean,
  p_level integer
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'hp', public.herzie_effective_hp(p_hp, p_hp_at, p_down, p_level, now()),
    'maxHp', public.herzie_max_hp(p_level),
    'stored', p_hp,
    'hpAt', case when p_hp_at is null then null
                 else (extract(epoch from p_hp_at) * 1000)::bigint end,
    'down', p_down
  );
$$;

create or replace function public.herzie_vitals(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level)
  from public.herzies h
  where h.user_id = p_user;
$$;

-- The Town server reports a player's absolute HP. It may only lower it:
-- compared against HP *now* (stored value plus regen), so a stale stored
-- value can't make a legitimate report look like a heal. Re-stamps hp_at, so
-- regen restarts its delay from every report while a fight is on. Reaching 0
-- knocks the herzie down.
create or replace function public.set_herzie_hp(p_user uuid, p_hp real)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h public.herzies%rowtype;
  eff real;
  next_hp real;
begin
  select * into h from public.herzies where user_id = p_user for update;
  if not found then
    return null;
  end if;
  if h.down then
    return public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level);
  end if;
  eff := public.herzie_effective_hp(h.hp, h.hp_at, h.down, h.level, now());
  next_hp := least(eff, greatest(coalesce(p_hp, eff), 0));
  if next_hp <= 0 then
    update public.herzies
      set hp = 0, hp_at = now(), down = true
      where user_id = p_user
      returning * into h;
  else
    update public.herzies
      set hp = next_hp, hp_at = now()
      where user_id = p_user
      returning * into h;
  end if;
  return public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level);
end;
$$;

-- Bench bonus: the Town server accrues seated seconds and adds the HP that
-- the faster bench regen earns on top of the base rate. Ignored while down;
-- capped at max HP. The write is stamped five seconds back so it doesn't
-- restart the regen delay.
create or replace function public.rest_herzie(p_user uuid, p_bonus real)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h public.herzies%rowtype;
  eff real;
  mx real;
begin
  select * into h from public.herzies where user_id = p_user for update;
  if not found then
    return null;
  end if;
  if h.down or coalesce(p_bonus, 0) <= 0 then
    return public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level);
  end if;
  mx := public.herzie_max_hp(h.level);
  eff := public.herzie_effective_hp(h.hp, h.hp_at, h.down, h.level, now());
  update public.herzies
    set hp = least(mx, eff + least(p_bonus, mx)),
        hp_at = now() - interval '5 seconds'
    where user_id = p_user
    returning * into h;
  return public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level);
end;
$$;

-- "Respawn in town": only for a knocked-out herzie, back with half its health.
create or replace function public.respawn_herzie(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h public.herzies%rowtype;
begin
  select * into h from public.herzies where user_id = p_user for update;
  if not found then
    return null;
  end if;
  if h.down then
    update public.herzies
      set hp = ceil(public.herzie_max_hp(h.level) * 0.5),
          hp_at = now(),
          down = false
      where user_id = p_user
      returning * into h;
  end if;
  return public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level);
end;
$$;

-- New functions start closed (00097); these are service-role only.
revoke execute on function public.herzie_max_hp(integer) from public, anon, authenticated;
revoke execute on function public.herzie_effective_hp(real, timestamptz, boolean, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.herzie_vitals_json(real, timestamptz, boolean, integer) from public, anon, authenticated;
revoke execute on function public.herzie_vitals(uuid) from public, anon, authenticated;
revoke execute on function public.set_herzie_hp(uuid, real) from public, anon, authenticated;
revoke execute on function public.rest_herzie(uuid, real) from public, anon, authenticated;
revoke execute on function public.respawn_herzie(uuid) from public, anon, authenticated;
