-- Choosing a class no longer hands over its instrument. Boboku sells every
-- instrument (00112), so a herzie buys theirs (or finds one); picking a class
-- sets the class and its first skill, nothing more. What's in the hand slots
-- stays as it is.
--
-- As 00106's, without the gear. The starter skill per class mirrors CLASS_DEFS
-- (packages/shared/src/classes.ts).
create or replace function public.choose_class(p_user_id uuid, p_class text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage int;
  v_class text;
  v_skill text;
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

  v_skill := case p_class
    when 'bard' then 'soothing-drones'
    when 'record_slinger' then 'backspin'
    when 'percussionist' then 'cymbrella'
  end;

  update public.herzies set class = p_class where user_id = p_user_id;

  insert into public.herzie_skills (user_id, skill_id)
  values (p_user_id, v_skill)
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'already', false, 'class', p_class,
    'state', public.item_state(p_user_id));
end;
$$;

revoke execute on function public.choose_class(uuid, text) from public, anon, authenticated;
