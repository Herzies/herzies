-- The cave's end screen: once a boss fight is over, the top ten damage
-- dealers and, for each herzie still in the cave, where they placed.
--
-- Read through the service role by `town-vitals`, on the Town server's
-- closing report (after that report's damage batch has landed). Ranks are
-- ordered as boss_leaderboard orders them (damage, then user id), so the
-- two never disagree.
--
-- Returns {"top": [{rank, name, damage}, ...], "you": {"<uid>": {rank, name,
-- damage}, ...}}. A herzie in `p_uids` who dealt no damage is left out of
-- "you".

create or replace function public.boss_results_json(p_event uuid, p_uids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with ranked as (
    select bd.user_id,
           h.name,
           bd.damage,
           row_number() over (order by bd.damage desc, bd.user_id) as rank
      from public.boss_damage bd
      join public.herzies h on h.user_id = bd.user_id
     where bd.event_id = p_event
       and bd.damage > 0
  )
  select jsonb_build_object(
    'top', coalesce((
      select jsonb_agg(jsonb_build_object(
               'rank', r.rank, 'name', r.name, 'damage', round(r.damage::numeric))
             order by r.rank)
        from ranked r
       where r.rank <= 10
    ), '[]'::jsonb),
    'you', coalesce((
      select jsonb_object_agg(r.user_id::text, jsonb_build_object(
               'rank', r.rank, 'name', r.name, 'damage', round(r.damage::numeric)))
        from ranked r
       where r.user_id = any (coalesce(p_uids, '{}'))
    ), '{}'::jsonb)
  );
$$;

revoke execute on function public.boss_results_json(uuid, uuid[]) from public, anon, authenticated;
