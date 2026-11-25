-- More Tower buffs (TOWER_BOON_IDS in shared tower.ts): Second Wind,
-- Crossover, Shockwave, Glass Cannon, Power Chord, Vigor and Opener join
-- the pool. tower_boon_keys (00162) is what tower_grant and
-- tower_progress_boons_check accept: every id at every rarity. Only grows,
-- so every climb's boons already kept still pass.

create or replace function public.tower_boon_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array_agg(i || ':' || r order by i, r)
    from unnest(array['speed', 'damage', 'def', 'crit', 'ferocity', 'tempo',
                      'thorns', 'executioner', 'second-wind', 'crossover',
                      'shockwave', 'glass-cannon', 'power-chord', 'vigor',
                      'opener']) as i,
         unnest(array['common', 'uncommon', 'rare', 'legendary', 'mythic']) as r;
$$;
revoke execute on function public.tower_boon_keys() from public, anon, authenticated;
