-- Timing: a fourth stat to spend points on. It quickens attacks and adds
-- crit chance (timingAttackSpeed / timingCritChance in
-- packages/shared/src/stats.ts); only the spent points are stored, like the
-- others (00108).
--
-- allocate_stats takes the new p_timing, defaulted to 0 so a caller that
-- predates it (the web route before this release) keeps working. The old
-- four-argument function is dropped rather than left beside it: with both,
-- a call naming four arguments would be ambiguous. Body otherwise as 00108.

alter table public.herzies
  add column if not exists stat_timing int not null default 0;

alter table public.herzies
  drop constraint if exists herzies_stat_points_nonnegative;
alter table public.herzies
  add constraint herzies_stat_points_nonnegative
  check (
    stat_stamina >= 0 and stat_sonic >= 0 and stat_euphony >= 0
    and stat_timing >= 0
  );

drop function if exists public.allocate_stats(uuid, int, int, int);

-- Sets the whole allocation at once (a reset is all zeros), so a retried
-- request can't spend twice. Mirrors `validateAllocation` in stats.ts.
-- Health already above a lowered max comes down to it.
create or replace function public.allocate_stats(
  p_user uuid,
  p_stamina int,
  p_sonic int,
  p_euphony int,
  p_timing int default 0
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
     or p_timing is null
     or p_stamina < 0 or p_sonic < 0 or p_euphony < 0 or p_timing < 0 then
    return jsonb_build_object('ok', false, 'reason', 'bad-points');
  end if;
  if p_stamina + p_sonic + p_euphony + p_timing
     > 2 * (greatest(h.level, 1) - 1) then
    return jsonb_build_object('ok', false, 'reason', 'too-many');
  end if;

  mx := public.herzie_max_hp(h.level, p_stamina);
  update public.herzies
     set stat_stamina = p_stamina,
         stat_sonic = p_sonic,
         stat_euphony = p_euphony,
         stat_timing = p_timing,
         hp = case when hp is not null and hp > mx then mx else hp end
   where user_id = p_user
   returning * into h;

  return jsonb_build_object(
    'ok', true,
    'statPoints', jsonb_build_object(
      'stamina', h.stat_stamina,
      'sonicPower', h.stat_sonic,
      'euphony', h.stat_euphony,
      'timing', h.stat_timing
    ),
    'vitals', public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level, h.stat_stamina)
  );
end;
$$;

-- Service-role only, as before (00097).
revoke execute on function public.allocate_stats(uuid, int, int, int, int) from public, anon, authenticated;
