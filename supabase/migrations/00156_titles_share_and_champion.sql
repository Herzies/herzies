-- ===========================================================================
-- 00156 — Titles: how rare each is, and the boss champion's on the spot
--
-- 1. titles_json also says how many herzies there are, so the Titles tab
--    can say what share of them hold a title ("Held by 3.2% of herzies")
--    rather than a bare count. One count of herzies a request, next to the
--    holders' one.
--
-- 2. Showstopper (boss-top: the top contributor when a boss falls, the
--    herzie the statue shows) was only granted when the Titles tab was
--    opened, so a champion who never looked didn't wear it, nor hear about
--    it. Now it's granted when the fight settles (a trigger on
--    boss_state.settled, whichever path settles it), and every champion so
--    far is granted it here. Both go through refresh_titles, so the
--    catalog's rule (bossTops ≥ 1) stays the one rule, and a grant that's
--    there already is a no-op. The grant isn't notified yet, so the next
--    sync hands it to the app for its toast.
-- ===========================================================================

-- The top contributor of a fallen boss, ranked as the statue ranks them
-- (00142 boss_champion_json): a rostered fight counts only those still in
-- at the end. Null for a boss still up, or one nobody hurt.
create or replace function public.boss_top(p_event uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.user_id
    from public.boss_state bs
    join public.boss_damage d on d.event_id = bs.event_id
   where bs.event_id = p_event
     and bs.killed
     and public.boss_contribution(d.damage + d.adds, d.healing, d.blocked, d.taunt) > 0
     and (not exists (select 1 from public.boss_participants bp
                       where bp.event_id = p_event)
          or exists (select 1 from public.boss_participants bp
                      where bp.event_id = p_event and bp.user_id = d.user_id
                        and bp.status = 'in'))
   order by public.boss_contribution(d.damage + d.adds, d.healing, d.blocked, d.taunt) desc,
            d.user_id
   limit 1;
$$;

-- Fallen bosses where this herzie was the top contributor (00152's, on
-- boss_top so the ranking lives in one place).
create or replace function public.boss_tops(p_user uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int
    from public.events e
   where e.type = 'boss_fight'
     -- Only the fights this herzie was in can be its.
     and exists (select 1 from public.boss_damage d
                  where d.event_id = e.id and d.user_id = p_user)
     and public.boss_top(e.id) = p_user;
$$;

-- A boss fight settled: its champion gets Showstopper (and whatever else
-- they've reached), at once.
create or replace function public.boss_state_grant_champion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_top uuid := public.boss_top(new.event_id);
begin
  if v_top is not null
     and exists (select 1 from public.herzies h where h.user_id = v_top) then
    perform public.refresh_titles(v_top);
  end if;
  return null;
end;
$$;

drop trigger if exists boss_state_grant_champion on public.boss_state;
create trigger boss_state_grant_champion
  after update of settled on public.boss_state
  for each row
  when (new.settled and not old.settled)
  execute function public.boss_state_grant_champion();

-- Every champion so far.
select public.refresh_titles(t.user_id)
  from (select distinct public.boss_top(bs.event_id) as user_id
          from public.boss_state bs
         where bs.killed) t
 where t.user_id is not null
   and exists (select 1 from public.herzies h where h.user_id = t.user_id);

-- Everything the Titles tab shows, after granting what's been reached
-- (00152's, plus `herzies`):
--   { worn, earned: [{id, earnedAt, count, fresh}], metrics,
--     holders: {titleId: herzies holding it}, herzies: herzies in all,
--     granted: [ids granted now] }
-- Null for a user without a herzie.
create or replace function public.titles_json(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worn    text;
  v_metrics jsonb;
  v_granted text[];
begin
  select title into v_worn from public.herzies where user_id = p_user;
  if not found then
    return null;
  end if;
  v_metrics := public.title_metrics(p_user);
  v_granted := public.grant_titles(p_user, v_metrics);
  return jsonb_build_object(
    'worn', v_worn,
    'earned', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', ht.title_id,
               'earnedAt', ht.earned_at,
               'count', ht.count,
               'fresh', not ht.seen
             ) order by ht.earned_at, ht.title_id)
        from public.herzie_titles ht
       where ht.user_id = p_user), '[]'::jsonb),
    'metrics', v_metrics,
    'holders', coalesce((
      select jsonb_object_agg(x.title_id, x.n)
        from (select title_id, count(*)::int as n
                from public.herzie_titles
               group by title_id) x), '{}'::jsonb),
    'herzies', (select count(*)::int from public.herzies),
    'granted', to_jsonb(v_granted)
  );
end;
$$;

revoke execute on function public.boss_top(uuid) from public, anon, authenticated;
revoke execute on function public.boss_tops(uuid) from public, anon, authenticated;
revoke execute on function public.boss_state_grant_champion() from public, anon, authenticated;
revoke execute on function public.titles_json(uuid) from public, anon, authenticated;
