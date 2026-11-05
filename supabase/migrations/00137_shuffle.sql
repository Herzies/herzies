-- Shuffle: the Record Slinger's second skill, learned at level 15 (as a
-- Bard learns Haste). Mirrors CLASS_DEFS.record_slinger.skills (classes.ts)
-- and SKILL_DEFS.shuffle.minLevel (skills.ts). No new tables: herzie_skills
-- takes any skill id, and the Town server decides what a skill does.

-- As in 00122, with Shuffle for a Record Slinger already at 15.
create or replace function public.choose_class(p_user_id uuid, p_class text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage  int;
  v_level  int;
  v_class  text;
  v_skills text[];
begin
  select stage, level, class into v_stage, v_level, v_class
    from public.herzies where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  if p_class is null or p_class not in ('bard', 'record_slinger', 'percussionist') then
    return jsonb_build_object('ok', false, 'reason', 'bad-class');
  end if;

  if v_class is not null then
    if v_class = p_class then
      return jsonb_build_object('ok', true, 'already', true, 'class', v_class,
        'state', public.item_state(p_user_id));
    end if;
    return jsonb_build_object('ok', false, 'reason', 'already-chosen');
  end if;

  if v_stage < 2 then
    return jsonb_build_object('ok', false, 'reason', 'stage-too-low');
  end if;

  v_skills := case p_class
    when 'bard' then array['soothing-drones', 'resurrect']
    when 'record_slinger' then array['backspin']
    when 'percussionist' then array['cymbrella', 'taunt']
  end;
  -- Learned at level 15 (grant_level_skills gives them then).
  if p_class = 'bard' and v_level >= 15 then
    v_skills := v_skills || array['haste'];
  end if;
  if p_class = 'record_slinger' and v_level >= 15 then
    v_skills := v_skills || array['shuffle'];
  end if;

  update public.herzies set class = p_class where user_id = p_user_id;

  insert into public.herzie_skills (user_id, skill_id)
  select p_user_id, s from unnest(v_skills) as s
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'already', false, 'class', p_class,
    'state', public.item_state(p_user_id));
end;
$$;

revoke execute on function public.choose_class(uuid, text) from public, anon, authenticated;

-- Skills learned on reaching a level: a Bard learns Haste at 15, a Record
-- Slinger Shuffle.
create or replace function public.grant_level_skills()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.level >= 15 then
    if new.class = 'bard' then
      insert into public.herzie_skills (user_id, skill_id)
      values (new.user_id, 'haste')
      on conflict do nothing;
    elsif new.class = 'record_slinger' then
      insert into public.herzie_skills (user_id, skill_id)
      values (new.user_id, 'shuffle')
      on conflict do nothing;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.grant_level_skills() from public, anon, authenticated;

drop trigger if exists herzies_grant_level_skills on public.herzies;
create trigger herzies_grant_level_skills
  after update of level, class on public.herzies
  for each row
  when (new.class in ('bard', 'record_slinger') and new.level >= 15)
  execute function public.grant_level_skills();

-- Record Slingers already at 15 or above learn it now.
insert into public.herzie_skills (user_id, skill_id)
select h.user_id, 'shuffle'
  from public.herzies h
 where h.class = 'record_slinger' and h.level >= 15
on conflict do nothing;
