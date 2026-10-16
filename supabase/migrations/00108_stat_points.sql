-- Stat points: Stamina, Sonic Power and Euphony.
--
-- A herzie earns 2 points for each level after the first (POINTS_PER_LEVEL in
-- packages/shared/src/stats.ts) and spends them freely, with a free reset.
-- Only the SPENT points are stored; what's left is always 2 × (level − 1) − spent,
-- so a level-up earns points without a write and existing herzies get their
-- back pay for nothing.
--
-- Stamina raises max HP, so herzie_max_hp gains a stamina argument and every
-- health function that reads it passes the row's points along. A defaulted
-- argument would make a second overload next to the old one, and calls with
-- the old arguments would then be ambiguous, so the old signatures are
-- dropped and recreated rather than replaced. Bodies otherwise as in 00101
-- and 00107.

alter table public.herzies
  add column if not exists stat_stamina int not null default 0,
  add column if not exists stat_sonic int not null default 0,
  add column if not exists stat_euphony int not null default 0;

alter table public.herzies
  drop constraint if exists herzies_stat_points_nonnegative;
alter table public.herzies
  add constraint herzies_stat_points_nonnegative
  check (stat_stamina >= 0 and stat_sonic >= 0 and stat_euphony >= 0);

drop function if exists public.herzie_vitals_json(real, timestamptz, boolean, integer);
drop function if exists public.herzie_effective_hp(real, timestamptz, boolean, integer, timestamptz);
drop function if exists public.herzie_max_hp(integer);

-- Max HP at a level, with this many points in Stamina. Mirrors `maxHp` in
-- vitals.ts (and STAT_TUNING.hpPerStamina in stats.ts).
create or replace function public.herzie_max_hp(
  p_level integer,
  p_stamina integer default 0
)
returns real
language sql
immutable
set search_path = ''
as $$
  select (100 + 5 * greatest(coalesce(p_level, 1), 1)
              + 10 * greatest(coalesce(p_stamina, 0), 0))::real;
$$;

-- HP at `p_now`. Mirrors `effectiveHp` in vitals.ts.
create or replace function public.herzie_effective_hp(
  p_hp real,
  p_hp_at timestamptz,
  p_down boolean,
  p_level integer,
  p_stamina integer,
  p_now timestamptz default now()
)
returns real
language sql
immutable
set search_path = ''
as $$
  select case
    when p_down then 0::real
    when p_hp is null or p_hp_at is null then public.herzie_max_hp(p_level, p_stamina)
    else least(
      public.herzie_max_hp(p_level, p_stamina),
      greatest(p_hp, 0)
        + greatest(extract(epoch from (p_now - p_hp_at)) - 5, 0)
          * public.herzie_max_hp(p_level, p_stamina) / 300.0
    )::real
  end;
$$;

-- The vitals as the clients see them. `hpAt` is ms since the epoch.
create or replace function public.herzie_vitals_json(
  p_hp real,
  p_hp_at timestamptz,
  p_down boolean,
  p_level integer,
  p_stamina integer
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'hp', public.herzie_effective_hp(p_hp, p_hp_at, p_down, p_level, p_stamina, now()),
    'maxHp', public.herzie_max_hp(p_level, p_stamina),
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
  select public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level, h.stat_stamina)
  from public.herzies h
  where h.user_id = p_user;
$$;

-- As in 00107: may only lower, except by what skills really restored.
create or replace function public.set_herzie_hp(
  p_user uuid,
  p_hp real,
  p_heal real default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h public.herzies%rowtype;
  eff real;
  ceiling real;
  next_hp real;
begin
  select * into h from public.herzies where user_id = p_user for update;
  if not found then
    return null;
  end if;
  if h.down then
    return public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level, h.stat_stamina);
  end if;
  eff := public.herzie_effective_hp(h.hp, h.hp_at, h.down, h.level, h.stat_stamina, now());
  ceiling := least(
    eff + greatest(coalesce(p_heal, 0), 0),
    public.herzie_max_hp(h.level, h.stat_stamina)
  );
  next_hp := least(ceiling, greatest(coalesce(p_hp, eff), 0));
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
  return public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level, h.stat_stamina);
end;
$$;

-- As in 00101.
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
    return public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level, h.stat_stamina);
  end if;
  mx := public.herzie_max_hp(h.level, h.stat_stamina);
  eff := public.herzie_effective_hp(h.hp, h.hp_at, h.down, h.level, h.stat_stamina, now());
  update public.herzies
    set hp = least(mx, eff + least(p_bonus, mx)),
        hp_at = now() - interval '5 seconds'
    where user_id = p_user
    returning * into h;
  return public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level, h.stat_stamina);
end;
$$;

-- As in 00101.
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
      set hp = ceil(public.herzie_max_hp(h.level, h.stat_stamina) * 0.5),
          hp_at = now(),
          down = false
      where user_id = p_user
      returning * into h;
  end if;
  return public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level, h.stat_stamina);
end;
$$;

-- Sets the whole allocation at once (a reset is all zeros), so a retried
-- request can't spend twice. Mirrors `validateAllocation` in stats.ts.
-- Health already above a lowered max comes down to it.
create or replace function public.allocate_stats(
  p_user uuid,
  p_stamina int,
  p_sonic int,
  p_euphony int
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h public.herzies%rowtype;
  mx real;
begin
  select * into h from public.herzies where user_id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;
  if p_stamina is null or p_sonic is null or p_euphony is null
     or p_stamina < 0 or p_sonic < 0 or p_euphony < 0 then
    return jsonb_build_object('ok', false, 'reason', 'bad-points');
  end if;
  if p_stamina + p_sonic + p_euphony > 2 * (greatest(h.level, 1) - 1) then
    return jsonb_build_object('ok', false, 'reason', 'too-many');
  end if;

  mx := public.herzie_max_hp(h.level, p_stamina);
  update public.herzies
     set stat_stamina = p_stamina,
         stat_sonic = p_sonic,
         stat_euphony = p_euphony,
         hp = case when hp is not null and hp > mx then mx else hp end
   where user_id = p_user
   returning * into h;

  return jsonb_build_object(
    'ok', true,
    'statPoints', jsonb_build_object(
      'stamina', h.stat_stamina,
      'sonicPower', h.stat_sonic,
      'euphony', h.stat_euphony
    ),
    'vitals', public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level, h.stat_stamina)
  );
end;
$$;

-- New functions start closed (00097); these are service-role only.
revoke execute on function public.herzie_max_hp(integer, integer) from public, anon, authenticated;
revoke execute on function public.herzie_effective_hp(real, timestamptz, boolean, integer, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.herzie_vitals_json(real, timestamptz, boolean, integer, integer) from public, anon, authenticated;
revoke execute on function public.herzie_vitals(uuid) from public, anon, authenticated;
revoke execute on function public.set_herzie_hp(uuid, real, real) from public, anon, authenticated;
revoke execute on function public.rest_herzie(uuid, real) from public, anon, authenticated;
revoke execute on function public.respawn_herzie(uuid) from public, anon, authenticated;
revoke execute on function public.allocate_stats(uuid, int, int, int) from public, anon, authenticated;
