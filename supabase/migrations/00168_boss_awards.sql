-- ===========================================================================
-- 00168 — Boss awards: Big Hitter, Soundproof, Lifesaver
--
-- A boss fight ranked everyone on one contribution score (00111, 00142),
-- so a Bard's healing and a Percussionist's holding were weighed against
-- a Record Slinger's damage on a scale nobody could read. Now each role is
-- ranked on its own work and its best herzie wins that role's award
-- (packages/shared/src/combat.ts: awardPoints, rankAwards,
-- pickAwardWinners, mirrored here):
--
--   dps      Big Hitter  damage + minion damage
--   tank     Soundproof  10 × HP blocked + the Taunt's points
--   support  Lifesaver   healing
--
-- One award a herzie: the surest claims go first (the biggest share of a
-- role; then dps, tank, support; then rank), so a herzie best at two keeps
-- the one it led by more. A role with nobody left has no winner.
--
-- 1. boss_awards: every herzie that counts for a fight, ranked in each role
--    it has points in, and the award it won (if any). The one place the
--    rules live; everything below reads it.
-- 2. boss_results_json (the end screen, relayed by town-vitals) and
--    boss_champion_json (the statue, through town-ticket and the front
--    page) in the awards' shape. The statue shows the three winners: each
--    role the winner of the latest fallen boss that had one, so a raid with
--    no tank leaves the last Soundproof up.
-- 3. Titles: a title for each award's first win, and Showstopper (boss-top)
--    for any award. Granted when the fight settles, and to every winner so
--    far here (as 00156 did for the champion).
-- 4. The single score's functions have no callers left and go:
--    boss_leaderboard, boss_top, boss_tops and the four-argument
--    boss_contribution (settle_boss_fight still calls the three-argument
--    one).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The rules
-- ---------------------------------------------------------------------------

-- Points a second held with a Taunt is worth, for a boss of `p_max_hp` and
-- a roster of `p_roster` (combat.ts tauntPointsPerSecond). Turns a tank's
-- Taunt points back into the seconds it held the boss.
create or replace function public.boss_taunt_points_per_second(
  p_max_hp real,
  p_roster int
)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_max_hp, 0) > 0
      -- TAUNT_CONTRIBUTION_WEIGHT × max HP, a herzie's share, over
      -- TAUNT_FIGHT_SECONDS.
      then 1.5 * p_max_hp::double precision
           / greatest(1, coalesce(p_roster, 1))
           / 390
    else 0
  end;
$$;

-- The role a class plays (classes.ts CLASS_DEFS[class].role). Null for a
-- herzie without a class.
create or replace function public.boss_class_role(p_class text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_class
    when 'bard' then 'support'
    when 'record_slinger' then 'dps'
    when 'percussionist' then 'tank'
  end;
$$;

-- A herzie's points in one role (combat.ts awardPoints).
create or replace function public.boss_award_points(
  p_role    text,
  p_damage  real,
  p_adds    real,
  p_healing real,
  p_blocked real,
  p_taunt   real
)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select case p_role
    when 'dps' then coalesce(p_damage, 0)::double precision
                    + coalesce(p_adds, 0)
    when 'tank' then 10 * coalesce(p_blocked, 0)::double precision
                     + coalesce(p_taunt, 0)
    when 'support' then coalesce(p_healing, 0)::double precision
    else 0
  end;
$$;

-- A fight's awards: one row for each herzie in each role it has points
-- in. A herzie counts if it has a herzie and, in a fight with a roster, is
-- still in. `share` is its part of the role's points (0–1), `rank` its
-- place in the role (points, then user id), `ranked` how many the role
-- ranks, and `won` whether this is the award it won (pickAwardWinners:
-- the biggest share first, then dps, tank, support, then rank; a herzie
-- that has won takes no other).
create or replace function public.boss_awards(p_event uuid)
returns table (
  user_id uuid,
  role    text,
  points  double precision,
  share   double precision,
  rank    int,
  ranked  int,
  won     boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive fight as (
    select exists (select 1 from public.boss_participants bp
                    where bp.event_id = p_event) as rostered
  ), counted as (
    select d.*
      from public.boss_damage d
      join public.herzies h on h.user_id = d.user_id
     cross join fight f
     where d.event_id = p_event
       and (not f.rostered or exists (
             select 1 from public.boss_participants bp
              where bp.event_id = p_event and bp.user_id = d.user_id
                and bp.status = 'in'))
  ), points as (
    select c.user_id, r.role, r.ord,
           public.boss_award_points(
             r.role, c.damage, c.adds, c.healing, c.blocked, c.taunt) as points
      from counted c
     cross join (values ('dps', 1), ('tank', 2), ('support', 3)) as r (role, ord)
  ), ranked as (
    select p.user_id, p.role, p.ord, p.points,
           p.points / sum(p.points) over (partition by p.role) as share,
           (row_number() over (partition by p.role
                               order by p.points desc, p.user_id))::int as rank,
           (count(*) over (partition by p.role))::int as ranked
      from points p
     where p.points > 0
  ), picked (role, user_id, roles, users) as (
    -- The claims walked surest first: each step takes the surest left of
    -- a role not won yet by a herzie that hasn't won.
    select null::text, null::uuid, '{}'::text[], '{}'::uuid[]
    union all
    select c.role, c.user_id, p.roles || c.role, p.users || c.user_id
      from picked p
     cross join lateral (
       select r.role, r.user_id
         from ranked r
        where not (r.role = any (p.roles))
          and not (r.user_id = any (p.users))
        order by r.share desc, r.ord, r.rank
        limit 1
     ) c
  )
  select r.user_id, r.role, r.points, r.share, r.rank, r.ranked,
         exists (select 1 from picked k
                  where k.role = r.role and k.user_id = r.user_id) as won
    from ranked r
   order by r.ord, r.rank;
$$;

-- ---------------------------------------------------------------------------
-- The end screen
-- ---------------------------------------------------------------------------

-- How a fight went, for its end screen (town-vitals turns each winner's
-- seed, stage and equipped into a look):
--   { awards: [{ role, winner: place + {seed, stage, equipped} | null,
--                top: [place, … the best 3] }, … dps, tank, support],
--     you: { uid: { role, won, place, of } } }
-- A place is { rank, name, share, damage, healed, blocked, tanked }, in
-- whole numbers (tanked in seconds) but for share. `you` holds the asked
-- for herzies with any points: in the role they won; else their class's,
-- if they have points in it; else where their share is biggest. `of` is
-- how many that role ranks.
create or replace function public.boss_results_json(p_event uuid, p_uids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with a as (
    select * from public.boss_awards(p_event)
  ), taunt as (
    -- The roster a Taunt's points were paid against: the roster, or, in a
    -- fight without one, everyone who did anything.
    select public.boss_taunt_points_per_second(
             (select bs.max_hp from public.boss_state bs
               where bs.event_id = p_event),
             coalesce(
               nullif((select count(*) from public.boss_participants bp
                        where bp.event_id = p_event), 0),
               (select count(*) from public.boss_damage d
                 where d.event_id = p_event))::int) as per_second
  ), place as (
    select a.user_id, a.role, a.rank, a.ranked, a.won, a.share,
           case a.role when 'dps' then 1 when 'tank' then 2 else 3 end as ord,
           h.class, h.friend_code, h.stage, h.equipped,
           jsonb_build_object(
             'rank', a.rank,
             'name', h.name,
             'share', a.share,
             'damage', round((d.damage + d.adds)::numeric),
             'healed', round(d.healing::numeric),
             'blocked', round(d.blocked::numeric),
             'tanked', case when coalesce(t.per_second, 0) > 0
                            then round((d.taunt / t.per_second)::numeric)
                            else 0 end
           ) as json
      from a
      join public.boss_damage d on d.event_id = p_event and d.user_id = a.user_id
      join public.herzies h on h.user_id = a.user_id
     cross join taunt t
  )
  select jsonb_build_object(
    'awards', (
      select jsonb_agg(jsonb_build_object(
               'role', r.role,
               'winner', (
                 select p.json || jsonb_build_object(
                          'seed', p.friend_code,
                          'stage', p.stage,
                          'equipped', p.equipped)
                   from place p
                  where p.role = r.role and p.won),
               'top', coalesce((
                 select jsonb_agg(p.json order by p.rank)
                   from place p
                  where p.role = r.role and p.rank <= 3), '[]'::jsonb))
             order by r.ord)
        from (values ('dps', 1), ('tank', 2), ('support', 3)) as r (role, ord)),
    'you', coalesce((
      select jsonb_object_agg(m.user_id::text, jsonb_build_object(
               'role', m.role,
               'won', m.won,
               'place', m.json,
               'of', m.ranked))
        from (select distinct on (p.user_id) p.*
                from place p
               where p.user_id = any (coalesce(p_uids, '{}'))
               order by p.user_id,
                        p.won desc,
                        p.role is not distinct from public.boss_class_role(p.class) desc,
                        p.share desc,
                        p.ord) m
    ), '{}'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- The statue
-- ---------------------------------------------------------------------------

-- Who the statue shows: { dps, tank, support }, each the award's winner at
-- the latest fallen boss that had one, as { event, name, seed, stage,
-- equipped }, or null if no fallen boss ever had one. `p_skip` (the
-- owner's herzie) never goes up: a role it won falls back to an older
-- fight.
create or replace function public.boss_champion_json(p_skip uuid[] default '{}'::uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with won as (
    select distinct on (a.role) a.role, e.id as event, a.user_id
      from public.events e
      join public.boss_state bs on bs.event_id = e.id
     cross join lateral public.boss_awards(e.id) a
     where e.type = 'boss_fight'
       and bs.killed
       and a.won
       and not (a.user_id = any (coalesce(p_skip, '{}')))
     order by a.role, bs.killed_at desc nulls last, e.id
  ), champion as (
    select w.role, jsonb_build_object(
             'event', w.event,
             'name', h.name,
             'seed', h.friend_code,
             'stage', h.stage,
             'equipped', h.equipped) as json
      from won w
      join public.herzies h on h.user_id = w.user_id
  )
  select jsonb_build_object(
    'dps', (select c.json from champion c where c.role = 'dps'),
    'tank', (select c.json from champion c where c.role = 'tank'),
    'support', (select c.json from champion c where c.role = 'support')
  );
$$;

-- ---------------------------------------------------------------------------
-- Titles
-- ---------------------------------------------------------------------------

-- An award's first win (titles.ts). Showstopper (boss-top) stays as 00152
-- seeded it, on bossTops: now any award.
insert into public.titles (id, metric, goal, retired) values
  ('boss-big-hitter', 'bossBigHitter', 1, false),
  ('boss-soundproof', 'bossSoundproof', 1, false),
  ('boss-lifesaver', 'bossLifesaver', 1, false)
on conflict (id) do update
  set metric = excluded.metric,
      goal = excluded.goal,
      retired = excluded.retired;

-- The awards this herzie has won at fallen bosses, by role.
create or replace function public.boss_awards_won(p_user uuid)
returns table (role text, wins int)
language sql
stable
security definer
set search_path = ''
as $$
  select a.role, count(*)::int
    from public.events e
    join public.boss_state bs on bs.event_id = e.id
   cross join lateral public.boss_awards(e.id) a
   where e.type = 'boss_fight'
     and bs.killed
     -- Only the fights this herzie was in can be its.
     and exists (select 1 from public.boss_damage d
                  where d.event_id = e.id and d.user_id = p_user)
     and a.user_id = p_user
     and a.won
   group by a.role;
$$;

-- The numbers titles are earned on, keyed exactly as TitleMetrics (00152's,
-- with the awards). Null for a user without a herzie.
create or replace function public.title_metrics(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'minutes', floor(h.total_minutes_listened)::bigint,
    'level', h.level,
    'streak', h.streak_days,
    'towerFloor', coalesce((
      select max(tp.best_floor) from public.tower_progress tp
       where tp.user_id = h.user_id), 0),
    'towerWins', public.tower_wins(h.user_id),
    'huntWins', public.count_song_hunt_wins(h.user_id),
    -- An hour or more (recordGenreMinutes only ever writes GENRES keys).
    'genres', (
      select count(*)::int from jsonb_each(h.genre_minutes) g
       where jsonb_typeof(g.value) = 'number' and (g.value)::numeric >= 60),
    'bossFights', (
      select count(*)::int from (
        select d.event_id
          from public.boss_damage d
          join public.events e on e.id = d.event_id
         where d.user_id = h.user_id
           and e.type = 'boss_fight'
           -- Did anything at all (none of these is ever negative).
           and d.damage + d.adds + d.healing + d.blocked + d.taunt > 0
        union
        select bp.event_id
          from public.boss_participants bp
         where bp.user_id = h.user_id
      ) fights),
    'bossTops', aw.total,
    'bossBigHitter', aw.dps,
    'bossSoundproof', aw.tank,
    'bossLifesaver', aw.support,
    'duelWins', coalesce(ds.wins, 0),
    'duelStreak', coalesce(ds.best_streak, 0),
    'mythics', (
      select count(distinct u.item_id)::int
        from public.item_units u
        join public.items i on i.id = u.item_id
       where u.user_id = h.user_id and i.rarity = 'mythic'),
    'friends', cardinality(h.friend_codes),
    'marketSales', (
      select coalesce(sum(l.quantity), 0)::int
        from public.market_listings l
       where l.seller_id = h.user_id and l.status = 'sold')
  )
    from public.herzies h
    left join public.duel_stats ds on ds.user_id = h.user_id
   cross join lateral (
     select coalesce(sum(w.wins), 0)::int as total,
            coalesce(sum(w.wins) filter (where w.role = 'dps'), 0)::int as dps,
            coalesce(sum(w.wins) filter (where w.role = 'tank'), 0)::int as tank,
            coalesce(sum(w.wins) filter (where w.role = 'support'), 0)::int as support
       from public.boss_awards_won(h.user_id) w
   ) aw
   where h.user_id = p_user;
$$;

-- A boss fight settled: its award winners get their titles (and whatever
-- else they've reached), at once. Replaces 00156's, which granted only the
-- champion.
create or replace function public.boss_state_grant_awards()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.killed then
    perform public.refresh_titles(a.user_id)
       from public.boss_awards(new.event_id) a
      where a.won;
  end if;
  return null;
end;
$$;

drop trigger if exists boss_state_grant_champion on public.boss_state;
drop function if exists public.boss_state_grant_champion();

drop trigger if exists boss_state_grant_awards on public.boss_state;
create trigger boss_state_grant_awards
  after update of settled on public.boss_state
  for each row
  when (new.settled and not old.settled)
  execute function public.boss_state_grant_awards();

-- Every winner so far.
select public.refresh_titles(t.user_id)
  from (select distinct a.user_id
          from public.boss_state bs
         cross join lateral public.boss_awards(bs.event_id) a
         where bs.killed
           and a.won) t;

-- ---------------------------------------------------------------------------
-- The single score, gone
-- ---------------------------------------------------------------------------

drop function if exists public.boss_leaderboard(uuid, int);
drop function if exists public.boss_tops(uuid);
drop function if exists public.boss_top(uuid);
drop function if exists public.boss_contribution(real, real, real, real);

revoke execute on function public.boss_taunt_points_per_second(real, int) from public, anon, authenticated;
revoke execute on function public.boss_class_role(text) from public, anon, authenticated;
revoke execute on function public.boss_award_points(text, real, real, real, real, real) from public, anon, authenticated;
revoke execute on function public.boss_awards(uuid) from public, anon, authenticated;
revoke execute on function public.boss_results_json(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.boss_champion_json(uuid[]) from public, anon, authenticated;
revoke execute on function public.boss_awards_won(uuid) from public, anon, authenticated;
revoke execute on function public.title_metrics(uuid) from public, anon, authenticated;
revoke execute on function public.boss_state_grant_awards() from public, anon, authenticated;
