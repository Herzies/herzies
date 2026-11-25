-- Silencio learned.
--
-- grant_earned_skills (00161) learns the Bard Silencio at herzie level 25
-- once its Rage is level 3 (SKILL_DEFS.silencio, skills.ts), whichever
-- comes last; whoever's already there learns it now.

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
      ('bard',           'haste',               15, null::text, 0),
      ('bard',           'rage',                20, null,       0),
      ('bard',           'silencio',            25, 'rage',     3),
      ('bard',           'focus',               30, 'rage',     8),
      ('record_slinger', 'shuffle',             15, null,       0),
      ('record_slinger', 'multispin',           20, 'shuffle',  8),
      ('record_slinger', 'forbidden-frequency', 30, null,       0),
      ('percussionist',  'rimshot',             15, null,       0),
      ('percussionist',  'cymbal-trap',         20, 'rimshot',  5)
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

select public.grant_earned_skills(h.user_id)
  from public.herzies h
 where h.class = 'bard';
