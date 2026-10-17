-- Every level makes a herzie a little sturdier: max HP starts at 110 and
-- grows by 8 a level (it was 100 + 5 a level). Its Sonic Power and Def grow
-- too (levelStats in packages/shared/src/stats.ts), but those are computed
-- where the stats are, not stored.
--
-- Mirrors `maxHp` in packages/shared/src/vitals.ts (STAT_TUNING.hpBase,
-- hpPerLevel, hpPerStamina). Same signature as 00108's, so every health
-- function that calls it picks the new formula up.
create or replace function public.herzie_max_hp(
  p_level integer,
  p_stamina integer default 0
)
returns real
language sql
immutable
set search_path = ''
as $$
  select (110 + 8 * (greatest(coalesce(p_level, 1), 1) - 1)
              + 10 * greatest(coalesce(p_stamina, 0), 0))::real;
$$;

revoke execute on function public.herzie_max_hp(integer, integer) from public, anon, authenticated;
