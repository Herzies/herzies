-- Class skills in the boss fight: healing, and skill XP.
--
-- The Town server runs the fight and reports through `town-vitals`. Two
-- things it couldn't say before:
--
-- 1. A herzie's health went UP (Soothing Drones). set_herzie_hp only ever
--    lowers, and that stays its rule: a report is still one absolute value.
--    It now also carries `p_heal`, the HP skills restored since the last
--    report the database took, and the stored health may rise toward the
--    reported value by at most that much. Never a delta added on top, so
--    damage and a heal in the same report window can't be counted twice.
--
-- 2. Skill XP. Additive, so applied once per batch id like boss damage
--    (00102). Levels follow from the total XP; the curve mirrors
--    skillXpForLevel / SKILL_MAX_LEVEL in packages/shared/src/skills.ts.

drop function if exists public.set_herzie_hp(uuid, real);

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
    return public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level);
  end if;
  eff := public.herzie_effective_hp(h.hp, h.hp_at, h.down, h.level, now());
  -- As high as it is now, plus what skills really restored; never past max.
  ceiling := least(
    eff + greatest(coalesce(p_heal, 0), 0),
    public.herzie_max_hp(h.level)
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
  return public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level);
end;
$$;

-- XP to go from `p_level` to the next (skillXpForLevel).
create or replace function public.skill_xp_for_level(p_level int)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select round(40 * power(p_level::numeric, 1.2))::bigint;
$$;

-- The level a skill with `p_xp` total XP is at (skillLevelForXp).
create or replace function public.skill_level_for_xp(p_xp bigint)
returns int
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_level int := 1;
  v_need bigint := 0;
begin
  while v_level < 10 loop
    v_need := v_need + public.skill_xp_for_level(v_level);
    exit when p_xp < v_need;
    v_level := v_level + 1;
  end loop;
  return v_level;
end;
$$;

create table if not exists public.skill_xp_batches (
  batch      text primary key,
  created_at timestamptz not null default now()
);
alter table public.skill_xp_batches enable row level security;
revoke all on public.skill_xp_batches from anon, authenticated;

create index if not exists skill_xp_batches_created_idx
  on public.skill_xp_batches (created_at);

-- p_xp: [{"uid": "<uuid>", "skill": "<skill id>", "xp": <int>}, ...]
-- Only a skill the herzie knows gains anything (choose_class creates the
-- row). Returns {"applied": bool, "levels": [{uid, skill, level}, ...]} with
-- where every named skill stands now — on a replay too, so a lost reply
-- still tells the Town server about a level-up.
create or replace function public.apply_skill_xp_batch(p_batch text, p_xp jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows int;
  v_item jsonb;
  v_levels jsonb;
begin
  if p_batch is null or length(p_batch) = 0 or length(p_batch) > 200 then
    raise exception 'bad batch id';
  end if;
  if jsonb_typeof(p_xp) is distinct from 'array'
     or jsonb_array_length(p_xp) > 200 then
    raise exception 'bad xp list';
  end if;

  insert into public.skill_xp_batches (batch) values (p_batch)
  on conflict (batch) do nothing;
  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    for v_item in select * from jsonb_array_elements(p_xp) loop
      -- One bad row mustn't lose everyone else's XP.
      begin
        update public.herzie_skills
           set xp = xp + least(greatest((v_item ->> 'xp')::bigint, 0), 100000),
               level = public.skill_level_for_xp(
                 xp + least(greatest((v_item ->> 'xp')::bigint, 0), 100000))
         where user_id = (v_item ->> 'uid')::uuid
           and skill_id = v_item ->> 'skill';
      exception when others then
        continue;
      end;
    end loop;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'uid', s.user_id, 'skill', s.skill_id, 'level', s.level)), '[]'::jsonb)
    into v_levels
    from public.herzie_skills s
    join (select distinct (e ->> 'uid') as uid, (e ->> 'skill') as skill
            from jsonb_array_elements(p_xp) e) w
      on s.user_id::text = w.uid and s.skill_id = w.skill;

  return jsonb_build_object('applied', v_rows > 0, 'levels', v_levels);
end;
$$;

revoke execute on function public.set_herzie_hp(uuid, real, real) from public, anon, authenticated;
revoke execute on function public.skill_xp_for_level(int) from public, anon, authenticated;
revoke execute on function public.skill_level_for_xp(bigint) from public, anon, authenticated;
revoke execute on function public.apply_skill_xp_batch(text, jsonb) from public, anon, authenticated;
