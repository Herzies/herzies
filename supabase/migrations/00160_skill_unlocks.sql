-- Skill unlocks: the skills a class learns later, each at a herzie level
-- and some only once another of the class's skills is far enough along.
-- New: Cymbal Trap (Percussionist, 20, Rimshot 5), Multispin (Record
-- Slinger, 20, Shuffle 8), Rage (Bard, 20) and Focus (Bard, 30, Rage 8).
-- What they do is the Town server's alone: nothing here but who knows
-- them. Mirrors SKILL_DEFS[*].minLevel and .requires (skills.ts) and
-- skillUnlocked; CLASS_DEFS[*].skills (classes.ts).
--
-- One function, grant_earned_skills, decides it all, and runs whenever
-- the answer can change: a class chosen, a herzie level reached, a skill
-- level reached.

create or replace function public.grant_earned_skills(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_level int;
  v_class text;
begin
  select level, class into v_level, v_class
    from public.herzies where user_id = p_user_id;
  if not found or v_class is null then
    return;
  end if;

  insert into public.herzie_skills (user_id, skill_id)
  select p_user_id, u.skill_id
    from (values
      ('bard',           'haste',       15, null::text, 0),
      ('bard',           'rage',        20, null,       0),
      ('bard',           'focus',       30, 'rage',     8),
      ('record_slinger', 'shuffle',     15, null,       0),
      ('record_slinger', 'multispin',   20, 'shuffle',  8),
      ('percussionist',  'rimshot',     15, null,       0),
      ('percussionist',  'cymbal-trap', 20, 'rimshot',  5)
    ) as u(class, skill_id, min_level, req_skill, req_level)
   where u.class = v_class
     and v_level >= u.min_level
     and (u.req_skill is null or exists (
       select 1 from public.herzie_skills s
        where s.user_id = p_user_id
          and s.skill_id = u.req_skill
          and s.level >= u.req_level))
  on conflict do nothing;
end;
$$;

revoke execute on function public.grant_earned_skills(uuid) from public, anon, authenticated;

-- As in 00138, but the skills learned later come from grant_earned_skills.
create or replace function public.choose_class(p_user_id uuid, p_class text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage  int;
  v_class  text;
  v_skills text[];
begin
  select stage, class into v_stage, v_class
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

  update public.herzies set class = p_class where user_id = p_user_id;

  insert into public.herzie_skills (user_id, skill_id)
  select p_user_id, s from unnest(v_skills) as s
  on conflict do nothing;

  -- Those its level has already earned (a skill that needs another's
  -- level can't be: its new skills are all at 1).
  perform public.grant_earned_skills(p_user_id);

  return jsonb_build_object('ok', true, 'already', false, 'class', p_class,
    'state', public.item_state(p_user_id));
end;
$$;

revoke execute on function public.choose_class(uuid, text) from public, anon, authenticated;

-- On reaching a herzie level (the trigger from 00138 still calls it, from
-- level 15 up: no skill is learned sooner).
create or replace function public.grant_level_skills()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.grant_earned_skills(new.user_id);
  return new;
end;
$$;

revoke execute on function public.grant_level_skills() from public, anon, authenticated;

-- On reaching a skill level (apply_skill_xp_batch levels skills up): one
-- skill's level may be what another needs.
create or replace function public.grant_skill_level_skills()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.grant_earned_skills(new.user_id);
  return new;
end;
$$;

revoke execute on function public.grant_skill_level_skills() from public, anon, authenticated;

drop trigger if exists herzie_skills_grant_skills on public.herzie_skills;
create trigger herzie_skills_grant_skills
  after update of level on public.herzie_skills
  for each row
  when (new.level > old.level)
  execute function public.grant_skill_level_skills();

-- Whoever has already earned one learns it now.
select public.grant_earned_skills(h.user_id)
  from public.herzies h
 where h.class is not null;
