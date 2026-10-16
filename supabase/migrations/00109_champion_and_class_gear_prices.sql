-- The Town's statue, and class gear that sells.
--
-- 1. boss_champion_json: whoever dealt the most damage in the last boss
--    fight that's over (its boss killed, or its window closed), with their
--    look, for the statue in the Town. A fight nobody fought (or only those
--    in `p_skip` did) is passed over for the one before it. Read through the
--    service role by `town-ticket`, which hands it to the app.
--
-- 2. The class instruments get a sell price. 00106 left them unsellable so a
--    class could never lose its gear; the owner chose to let players sell
--    them anyway (2026-10-16). Trading them stays refused.

create or replace function public.boss_champion_json(p_skip uuid[] default '{}')
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with over as (
    select e.id, coalesce(bs.killed_at, e.ends_at) as over_at
      from public.events e
      left join public.boss_state bs on bs.event_id = e.id
     where e.type = 'boss_fight'
       and (coalesce(bs.killed, false) or e.ends_at <= now())
  ), top as (
    select d.user_id, d.event_id, d.damage
      from over o
      join public.boss_damage d on d.event_id = o.id
     where d.damage > 0
       and not (d.user_id = any (coalesce(p_skip, '{}')))
     order by o.over_at desc, d.damage desc, d.user_id
     limit 1
  )
  select jsonb_build_object(
    'event', t.event_id,
    'damage', t.damage,
    'name', h.name,
    'seed', h.friend_code,
    'stage', h.stage,
    'equipped', h.equipped
  )
    from top t
    join public.herzies h on h.user_id = t.user_id;
$$;

revoke execute on function public.boss_champion_json(uuid[]) from public, anon, authenticated;

update public.items
   set sell_price = 10
 where id in ('lute', 'compact-discs', 'worn-stick', 'old-cymbal');
