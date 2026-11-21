-- ===========================================================================
-- 00152 — Titles, duel results, loadouts
--
-- Titles (packages/shared/src/titles.ts): proofs of feats, worn on a line
-- under the name. Earned for good on the herzie, never taken back. The
-- catalog's names and copy live in TypeScript; SQL keeps only what it needs
-- to grant them (the metric and goal), and a shared test keeps the two
-- equal. refresh_titles grants every title a herzie has reached; it runs
-- where a metric moves (a duel, a Tower floor, a song hunt, a sync that
-- crosses a goal) and whenever the Titles tab is opened, which catches the
-- rest (friends, the Market, a Tower month closing, a fallen boss).
--
-- Duels (packages/shared/src/duel.ts): the Town server reports every
-- finished duel to town-vitals, which lands it in record_duel: once per
-- duel id, a win counting towards titles only when the room credited it
-- and it's the winner's first counted win over that loser this UTC day.
--
-- Loadouts (packages/shared/src/loadouts.ts): two sets of gear. What's worn
-- is still only item_units.equipped_slot; loadout_items holds the other
-- set, and a copy it holds that isn't worn is out of the bag (Guild Wars 2's
-- model): it takes no bag slot and can't be sold, listed, traded or spent.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The catalog, as far as granting goes. Equal to TITLES (titles.test.ts).
-- ---------------------------------------------------------------------------
create table if not exists public.titles (
  id      text primary key,
  -- A TitleMetrics key. Null for a title nothing grants any more.
  metric  text,
  goal    int,
  retired boolean not null default false,
  constraint titles_metric_goal check ((metric is null) = (goal is null))
);
alter table public.titles enable row level security;
revoke all on public.titles from anon, authenticated;

insert into public.titles (id, metric, goal, retired) values
  ('listen-50', 'minutes', 3000, false),
  ('listen-100', 'minutes', 6000, false),
  ('listen-200', 'minutes', 12000, false),
  ('listen-500', 'minutes', 30000, false),
  ('listen-1000', 'minutes', 60000, false),
  ('genres-all', 'genres', 15, false),
  ('streak-7', 'streak', 7, false),
  ('streak-30', 'streak', 30, false),
  ('streak-100', 'streak', 100, false),
  ('streak-365', 'streak', 365, false),
  ('level-10', 'level', 10, false),
  ('level-25', 'level', 25, false),
  ('level-50', 'level', 50, false),
  ('level-100', 'level', 100, false),
  ('tower-10', 'towerFloor', 10, false),
  ('tower-20', 'towerFloor', 20, false),
  ('tower-40', 'towerFloor', 40, false),
  ('tower-60', 'towerFloor', 60, false),
  ('tower-100', 'towerFloor', 100, false),
  ('tower-top', 'towerWins', 1, false),
  ('hunt-1', 'huntWins', 1, false),
  ('hunt-10', 'huntWins', 10, false),
  ('hunt-25', 'huntWins', 25, false),
  ('boss-10', 'bossFights', 10, false),
  ('boss-top', 'bossTops', 1, false),
  ('duel-1', 'duelWins', 1, false),
  ('duel-10', 'duelWins', 10, false),
  ('duel-50', 'duelWins', 50, false),
  ('duel-streak-10', 'duelStreak', 10, false),
  ('mythic-1', 'mythics', 1, false),
  ('mythic-5', 'mythics', 5, false),
  ('friends-10', 'friends', 10, false),
  ('market-25', 'marketSales', 25, false),
  ('original-pressing', null, null, true)
on conflict (id) do update
  set metric = excluded.metric,
      goal = excluded.goal,
      retired = excluded.retired;

-- ---------------------------------------------------------------------------
-- Who has earned what. `seen`: looked at in the Titles tab (its NEW pill).
-- `notified`: handed to the app by a sync (its toast), at most once.
-- ---------------------------------------------------------------------------
create table if not exists public.herzie_titles (
  user_id   uuid not null references public.herzies(user_id) on delete cascade,
  title_id  text not null references public.titles(id),
  earned_at timestamptz not null default now(),
  -- Times earned: only Chart Topper (one per Tower month won) goes past 1.
  count     int not null default 1 check (count >= 1),
  seen      boolean not null default false,
  notified  boolean not null default false,
  primary key (user_id, title_id)
);
create index if not exists herzie_titles_title_idx
  on public.herzie_titles (title_id);
alter table public.herzie_titles enable row level security;
revoke all on public.herzie_titles from anon, authenticated;
grant select on public.herzie_titles to authenticated;
drop policy if exists "Own titles" on public.herzie_titles;
create policy "Own titles" on public.herzie_titles
  for select to authenticated
  using (user_id = (select auth.uid()));

-- The title worn, or none. Only set_title writes it, and only to one earned.
alter table public.herzies
  add column if not exists title text references public.titles(id);

-- ---------------------------------------------------------------------------
-- Duel results. No foreign keys on the duelists: a herzie that's deleted
-- shouldn't take its opponents' wins with it.
-- ---------------------------------------------------------------------------
create table if not exists public.duel_results (
  -- The room's id for the duel; a retried report finds it here.
  id         text primary key check (length(id) between 1 and 200),
  a          uuid not null,
  b          uuid not null,
  winner     uuid,
  loser      uuid,
  why        text not null
             check (why in ('defeat', 'yield', 'bounds', 'left', 'time', 'draw')),
  ms         int not null check (ms >= 0),
  -- Per duelist (uid → number): damage dealt, duel max HP, level.
  damage     jsonb not null default '{}',
  max_hp     jsonb not null default '{}',
  level      jsonb not null default '{}',
  -- What the room judged (duelCredited): a real fight, not a farmed one.
  credited   boolean not null,
  -- Whether the win counted towards titles: credited, and the winner's
  -- first counted win over this loser on `day`.
  counted    boolean not null default false,
  -- The UTC day it ended, for the once-a-day rule.
  day        date not null,
  created_at timestamptz not null default now(),
  constraint duel_results_pair check (a <> b),
  constraint duel_results_sides check (
    (winner is null and loser is null and why = 'draw')
    or (why <> 'draw' and (winner, loser) in ((a, b), (b, a)))
  )
);
-- The once-a-day rule, under concurrency too: a second counted win of the
-- same pair the same day can't be written.
create unique index if not exists duel_results_counted_uidx
  on public.duel_results (winner, loser, day) where counted;
create index if not exists duel_results_winner_idx
  on public.duel_results (winner) where counted;
alter table public.duel_results enable row level security;
revoke all on public.duel_results from anon, authenticated;

-- Running totals per herzie, kept by record_duel.
create table if not exists public.duel_stats (
  user_id     uuid primary key references public.herzies(user_id) on delete cascade,
  -- Counted wins (duelWins).
  wins        int not null default 0,
  -- Losses that count (see record_duel).
  losses      int not null default 0,
  draws       int not null default 0,
  -- Counted wins since the last loss that counts, and the best such run
  -- (duelStreak).
  streak      int not null default 0,
  best_streak int not null default 0,
  updated_at  timestamptz not null default now()
);
alter table public.duel_stats enable row level security;
revoke all on public.duel_stats from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Loadouts. active_loadout is the set being worn; loadout_items holds only
-- the other one (the worn one is item_units.equipped_slot). A copy with a
-- row is held: out of the bag unless it's also worn (a copy can be in both
-- loadouts). A copy that's deleted leaves its row with the item id, so the
-- switch can say what's missing.
-- ---------------------------------------------------------------------------
alter table public.herzies
  add column if not exists active_loadout smallint not null default 1
    check (active_loadout in (1, 2)),
  -- Null until the first switch: the other loadout doesn't exist until then.
  add column if not exists loadout_switched_at timestamptz;

create table if not exists public.loadout_items (
  user_id  uuid not null references public.herzies(user_id) on delete cascade,
  loadout  smallint not null check (loadout in (1, 2)),
  -- An item_units.equipped_slot: modifiers each have a row in 'modifier'.
  slot     text not null check (slot in (
             'head', 'face', 'body', 'scenery', 'ground_left', 'ground_right',
             'spirit', 'color', 'modifier', 'main_hand', 'off_hand', 'back',
             'feet'
           )),
  unit_id  uuid references public.item_units(id) on delete set null,
  item_id  text not null,
  -- The order the modifiers were put on (0 for the other slots).
  position int not null default 0,
  primary key (user_id, loadout, slot, position)
);
-- For the FK's on delete set null: copies are deleted often (listing,
-- dice, eating), and each delete looks here.
create index if not exists loadout_items_unit_idx
  on public.loadout_items (unit_id) where unit_id is not null;
alter table public.loadout_items enable row level security;
revoke all on public.loadout_items from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Clients have no write grant on herzies (00097); this keeps the title and
-- the loadout server-written if one ever comes back. Same guard as emotes
-- (00132).
-- ---------------------------------------------------------------------------
create or replace function public.herzies_guard_title_loadout()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and (
       (tg_op = 'INSERT' and (new.title is not null
                              or new.active_loadout <> 1
                              or new.loadout_switched_at is not null))
    or (tg_op = 'UPDATE' and (new.title is distinct from old.title
                              or new.active_loadout is distinct from old.active_loadout
                              or new.loadout_switched_at is distinct from old.loadout_switched_at))
  ) then
    raise exception 'title and loadout can only be changed through the API';
  end if;
  return new;
end;
$$;

drop trigger if exists herzies_guard_title_loadout on public.herzies;
create trigger herzies_guard_title_loadout
  before insert or update on public.herzies
  for each row execute function public.herzies_guard_title_loadout();

revoke execute on function public.herzies_guard_title_loadout() from public, anon, authenticated;

-- ===========================================================================
-- Titles
-- ===========================================================================

-- Tower months closed with this herzie first on the board (00121's
-- tower_winner, which skips the excluded).
create or replace function public.tower_wins(p_user uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int
    from public.events e
   where e.type = 'tower'
     and e.active
     and e.ends_at <= now()
     and public.tower_winner(e.id) = p_user;
$$;

-- Fallen bosses where this herzie was the top contributor, ranked as the
-- statue ranks them (00142 boss_champion_json): a rostered fight counts
-- only those still in at the end.
create or replace function public.boss_tops(p_user uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  with fallen as (
    select e.id,
           exists (select 1 from public.boss_participants bp
                    where bp.event_id = e.id) as rostered
      from public.events e
      join public.boss_state bs on bs.event_id = e.id
     where e.type = 'boss_fight'
       and bs.killed
       -- Only the fights this herzie was in can be its.
       and exists (select 1 from public.boss_damage d
                    where d.event_id = e.id and d.user_id = p_user)
  ), tops as (
    select distinct on (f.id) f.id, d.user_id
      from fallen f
      join public.boss_damage d on d.event_id = f.id
     where public.boss_contribution(d.damage + d.adds, d.healing, d.blocked, d.taunt) > 0
       and (not f.rostered or exists (
             select 1 from public.boss_participants bp
              where bp.event_id = f.id and bp.user_id = d.user_id
                and bp.status = 'in'))
     order by f.id,
              public.boss_contribution(d.damage + d.adds, d.healing, d.blocked, d.taunt) desc,
              d.user_id
  )
  select count(*)::int from tops where user_id = p_user;
$$;

-- The numbers titles are earned on, keyed exactly as TitleMetrics. Null for
-- a user without a herzie.
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
           and public.boss_contribution(d.damage + d.adds, d.healing, d.blocked, d.taunt) > 0
        union
        select bp.event_id
          from public.boss_participants bp
         where bp.user_id = h.user_id
      ) fights),
    'bossTops', public.boss_tops(h.user_id),
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
   where h.user_id = p_user;
$$;

-- Grants every title `p_metrics` reaches and returns the ones that are new.
-- Chart Topper's count follows the months won. Internal: callers go through
-- refresh_titles or titles_json, which read the metrics first.
create or replace function public.grant_titles(p_user uuid, p_metrics jsonb)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new  text[];
  v_wins int;
begin
  if p_metrics is null then
    return '{}'::text[];
  end if;

  with reached as (
    select t.id
      from public.titles t
     where not t.retired
       and t.metric is not null
       and coalesce((p_metrics ->> t.metric)::numeric, 0) >= t.goal
  ), ins as (
    insert into public.herzie_titles (user_id, title_id)
    select p_user, r.id from reached r
    on conflict (user_id, title_id) do nothing
    returning title_id
  )
  select coalesce(array_agg(title_id order by title_id), '{}'::text[])
    into v_new
    from ins;

  v_wins := coalesce((p_metrics ->> 'towerWins')::int, 0);
  if v_wins > 1 then
    update public.herzie_titles
       set count = v_wins
     where user_id = p_user and title_id = 'tower-top' and count < v_wins;
  end if;

  return v_new;
end;
$$;

-- Grants every title this herzie has reached; returns the newly granted.
create or replace function public.refresh_titles(p_user uuid)
returns text[]
language sql
security definer
set search_path = ''
as $$
  select public.grant_titles(p_user, public.title_metrics(p_user));
$$;

-- The titles a sync hands the app for its toast: every one not handed over
-- yet, marked as handed over in the same statement, so two syncs racing
-- can't both get one (at most once). `p_refresh`: grant first (the sync saw
-- a goal crossed, or a song hunt was won).
create or replace function public.take_new_titles(p_user uuid, p_refresh boolean default false)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids text[];
begin
  if p_refresh then
    perform public.refresh_titles(p_user);
  end if;
  with taken as (
    update public.herzie_titles
       set notified = true
     where user_id = p_user and not notified
    returning title_id
  )
  select coalesce(array_agg(title_id order by title_id), '{}'::text[])
    into v_ids
    from taken;
  return v_ids;
end;
$$;

-- Wear an earned title, or none (null).
-- { ok, worn } | { ok: false, reason: 'unknown' | 'not-earned' | 'not-found' }
create or replace function public.set_title(p_user uuid, p_title text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_title is not null then
    if not exists (select 1 from public.titles where id = p_title) then
      return jsonb_build_object('ok', false, 'reason', 'unknown');
    end if;
    if not exists (
      select 1 from public.herzie_titles
       where user_id = p_user and title_id = p_title
    ) then
      return jsonb_build_object('ok', false, 'reason', 'not-earned');
    end if;
  end if;
  update public.herzies set title = p_title where user_id = p_user;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;
  return jsonb_build_object('ok', true, 'worn', p_title);
end;
$$;

-- The Titles tab looked at these: their NEW pill goes.
create or replace function public.mark_titles_seen(p_user uuid, p_ids text[])
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows int;
begin
  update public.herzie_titles
     set seen = true
   where user_id = p_user
     and title_id = any(coalesce(p_ids, '{}'::text[]))
     and not seen;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Everything the Titles tab shows, after granting what's been reached
-- (this is where titles no other path grants are caught):
--   { worn, earned: [{id, earnedAt, count, fresh}], metrics,
--     holders: {titleId: herzies holding it}, granted: [ids granted now] }
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
    'granted', to_jsonb(v_granted)
  );
end;
$$;

revoke execute on function public.tower_wins(uuid) from public, anon, authenticated;
revoke execute on function public.boss_tops(uuid) from public, anon, authenticated;
revoke execute on function public.title_metrics(uuid) from public, anon, authenticated;
revoke execute on function public.grant_titles(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.refresh_titles(uuid) from public, anon, authenticated;
revoke execute on function public.take_new_titles(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.set_title(uuid, text) from public, anon, authenticated;
revoke execute on function public.mark_titles_seen(uuid, text[]) from public, anon, authenticated;
revoke execute on function public.titles_json(uuid) from public, anon, authenticated;

-- ===========================================================================
-- Duels
-- ===========================================================================

-- A finished duel, as the room reports it (town-vitals action "duel").
-- Once per id: a retried report changes nothing. Returns
--   { recorded: false } for a replay, else
--   { recorded: true, counted, titles: {uid: [newly granted ids]} }.
--
-- The winner's win counts (duelWins, the streak) when the room credited it
-- and it's the first counted win over this loser today (UTC). The loser's
-- loss counts (ending its streak) when the room credited the duel, or the
-- loser gave it up (yielded, left the ring, left the room): giving up can't
-- dodge a loss, while a stomp the room didn't credit (a big level gap) and
-- a repeat loss to the same herzie today still do count, as losses aren't
-- deduplicated. Draws count for neither and break no streak.
create or replace function public.record_duel(
  p_id       text,
  p_a        uuid,
  p_b        uuid,
  p_winner   uuid,
  p_why      text,
  p_ms       integer,
  p_damage   jsonb,
  p_max_hp   jsonb,
  p_level    jsonb,
  p_credited boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loser   uuid;
  v_day     date := (now() at time zone 'utc')::date;
  v_counted boolean := false;
  v_loss    boolean;
  v_rows    int;
begin
  v_loser := case p_winner when p_a then p_b when p_b then p_a end;

  insert into public.duel_results
    (id, a, b, winner, loser, why, ms, damage, max_hp, level, credited, day)
  values
    (p_id, p_a, p_b, p_winner, v_loser, p_why, greatest(0, coalesce(p_ms, 0)),
     coalesce(p_damage, '{}'::jsonb), coalesce(p_max_hp, '{}'::jsonb),
     coalesce(p_level, '{}'::jsonb), coalesce(p_credited, false), v_day)
  on conflict (id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return jsonb_build_object('recorded', false);
  end if;

  if p_winner is not null and coalesce(p_credited, false) then
    begin
      update public.duel_results set counted = true where id = p_id;
      v_counted := true;
    exception when unique_violation then
      -- Already a counted win over this herzie today.
      v_counted := false;
    end;
  end if;

  v_loss := v_loser is not null
    and (coalesce(p_credited, false) or p_why in ('yield', 'bounds', 'left'));

  -- Both rows in one statement, in a fixed order, so two reports touching
  -- the same herzie can't deadlock.
  insert into public.duel_stats as s
    (user_id, wins, losses, draws, streak, best_streak)
  select x.uid, x.win, x.loss, x.draw, x.win, x.win
    from (values
      (p_a,
       (v_counted and p_a = p_winner)::int,
       (v_loss and p_a = v_loser)::int,
       (p_winner is null)::int),
      (p_b,
       (v_counted and p_b = p_winner)::int,
       (v_loss and p_b = v_loser)::int,
       (p_winner is null)::int)
    ) as x(uid, win, loss, draw)
   where exists (select 1 from public.herzies h where h.user_id = x.uid)
   order by x.uid
  on conflict (user_id) do update
    set wins = s.wins + excluded.wins,
        losses = s.losses + excluded.losses,
        draws = s.draws + excluded.draws,
        streak = case when excluded.losses > 0 then 0
                      else s.streak + excluded.wins end,
        best_streak = greatest(s.best_streak, s.streak + excluded.wins),
        updated_at = now();

  return jsonb_build_object(
    'recorded', true,
    'counted', v_counted,
    'titles', jsonb_build_object(
      p_a::text, to_jsonb(public.refresh_titles(p_a)),
      p_b::text, to_jsonb(public.refresh_titles(p_b))
    )
  );
end;
$$;

revoke execute on function public.record_duel(text, uuid, uuid, uuid, text, integer, jsonb, jsonb, jsonb, boolean)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- tower_grant — as in 00121, and a new best floor past a Tower title's goal
-- grants it.
-- ---------------------------------------------------------------------------
create or replace function public.tower_grant(
  p_user     uuid,
  p_event    uuid,
  p_batch    text,
  p_xp       integer,
  p_cleared  integer,
  p_item_ids text[],
  p_xp_cap   integer,
  p_drop_cap integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows  int;
  v_today date := (now() at time zone 'utc')::date;
  v_daily public.tower_daily%rowtype;
  v_xp    int;
  v_room  int;
  v_drops jsonb := '[]'::jsonb;
  v_item  text;
  v_id    uuid;
  v_lands timestamptz := now() + interval '90 seconds';
  v_best  int;
begin
  if p_batch is null or length(p_batch) = 0 or length(p_batch) > 200 then
    raise exception 'bad batch id';
  end if;
  if coalesce(array_length(p_item_ids, 1), 0) > 50 then
    raise exception 'too many drops';
  end if;

  insert into public.tower_batches (batch) values (p_batch)
  on conflict (batch) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return jsonb_build_object('drops', '[]'::jsonb);
  end if;

  if not exists (select 1 from public.herzies where user_id = p_user) then
    return jsonb_build_object('drops', '[]'::jsonb);
  end if;

  if coalesce(p_cleared, 0) > 0 then
    -- The best floor over every Tower so far, before this one moves.
    select coalesce(max(best_floor), 0) into v_best
      from public.tower_progress where user_id = p_user;

    insert into public.tower_progress (user_id, event_id, best_floor)
    values (p_user, p_event, p_cleared)
    on conflict (user_id, event_id) do update
      set best_floor = greatest(public.tower_progress.best_floor, excluded.best_floor),
          -- Only a new best moves the time: it breaks ties (the earlier
          -- one wins), so playing on without climbing mustn't cost you.
          updated_at = case
            when excluded.best_floor > public.tower_progress.best_floor
              then now()
            else public.tower_progress.updated_at
          end;

    if exists (
      select 1 from public.titles t
       where t.metric = 'towerFloor' and not t.retired
         and t.goal > v_best and t.goal <= p_cleared
    ) then
      perform public.refresh_titles(p_user);
    end if;
  end if;

  insert into public.tower_daily (user_id, day) values (p_user, v_today)
  on conflict (user_id, day) do nothing;
  select * into v_daily from public.tower_daily
   where user_id = p_user and day = v_today
   for update;

  v_xp := greatest(0, least(coalesce(p_xp, 0), p_xp_cap - v_daily.xp));
  v_room := greatest(0, p_drop_cap - v_daily.drops);

  if v_xp > 0 then
    update public.herzies set pending_xp = pending_xp + v_xp
     where user_id = p_user;
  end if;

  foreach v_item in array coalesce(p_item_ids, '{}'::text[]) loop
    exit when v_room <= 0;
    continue when not exists (select 1 from public.items where id = v_item);
    insert into public.pending_drops (user_id, item_id, dropped_at, source_event)
    values (p_user, v_item, v_lands, p_event)
    returning id into v_id;
    v_drops := v_drops || jsonb_build_object('id', v_id, 'item', v_item);
    v_room := v_room - 1;
  end loop;

  update public.tower_daily
     set xp = xp + v_xp,
         drops = drops + jsonb_array_length(v_drops)
   where user_id = p_user and day = v_today;

  return jsonb_build_object('drops', v_drops);
end;
$$;

revoke execute on function public.tower_grant(uuid, uuid, text, integer, integer, text[], integer, integer)
  from public, anon, authenticated;

-- ===========================================================================
-- Loadouts
-- ===========================================================================

-- The bag, everywhere it's counted. A copy is in the bag when it isn't worn
-- and no loadout holds it:
--   equipped_slot is null
--   and not exists (select 1 from public.loadout_items li where li.unit_id = u.id)
-- (only the inactive loadout ever has rows, and a held copy can't leave its
-- owner: every path that hands a copy over refuses held ones, below).

-- item_projection as 00079, except that inventory_v2 leaves out held copies
-- that aren't worn. Every bag-slot count in TypeScript (bankSlotsUsed,
-- hasRoomFor, the buy routes, the desktop) reads inventory_v2, so they all
-- count the bag right without knowing about loadouts. What's owned for
-- other reasons (titles' mythics) reads item_units directly.
create or replace function public.item_projection(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'inventory', coalesce((
      select jsonb_object_agg(x.item_id, x.n)
        from (select u.item_id, count(*)::int as n
                from public.item_units u
               where u.user_id = p_user_id
                 and (u.equipped_slot is not null
                      or not exists (select 1 from public.loadout_items li
                                      where li.unit_id = u.id))
               group by u.item_id) x
    ), '{}'::jsonb),
    'upgrades', coalesce((
      select jsonb_object_agg(x.item_id, x.lvl)
        from (select u.item_id,
                     coalesce(
                       max(u.upgrade_level) filter (where u.equipped_slot is not null),
                       max(u.upgrade_level)
                     ) as lvl
                from public.item_units u
               where u.user_id = p_user_id
               group by u.item_id) x
       where x.lvl > 0
    ), '{}'::jsonb),
    'equipped',
      coalesce((
        select jsonb_object_agg(u.equipped_slot, u.item_id)
          from public.item_units u
         where u.user_id = p_user_id
           and u.equipped_slot is not null
           and u.equipped_slot <> 'modifier'
      ), '{}'::jsonb)
      || coalesce((
        select jsonb_build_object(
                 'modifier', jsonb_agg(u.item_id order by u.equipped_at, u.id))
          from public.item_units u
         where u.user_id = p_user_id and u.equipped_slot = 'modifier'
        having count(*) > 0
      ), '{}'::jsonb)
  );
$$;

-- A loadout taking or giving back a copy moves it out of or into the bag, so
-- the projection refreshes on loadout_items too. 00079's trigger function
-- reads only user_id off the transition tables, which this table has.
drop trigger if exists loadout_items_refresh_ins on public.loadout_items;
create trigger loadout_items_refresh_ins
  after insert on public.loadout_items
  referencing new table as new_rows
  for each statement execute function public.item_units_refresh_trg();

drop trigger if exists loadout_items_refresh_del on public.loadout_items;
create trigger loadout_items_refresh_del
  after delete on public.loadout_items
  referencing old table as old_rows
  for each statement execute function public.item_units_refresh_trg();

-- Also fired by the FK's on delete set null when a held copy is deleted.
drop trigger if exists loadout_items_refresh_upd on public.loadout_items;
create trigger loadout_items_refresh_upd
  after update on public.loadout_items
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.item_units_refresh_trg();

-- The units as the clients read them (00079), plus `heldBy` (ItemUnit.heldBy)
-- on a copy the inactive loadout holds, worn or not; absent otherwise.
create or replace function public.item_units_json(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', u.id,
             'itemId', u.item_id,
             'upgradeLevel', u.upgrade_level,
             'equippedSlot', u.equipped_slot
           )
           || case when held.loadout is null then '{}'::jsonb
                   else jsonb_build_object('heldBy', held.loadout) end
           order by u.acquired_at, u.id), '[]'::jsonb)
    from public.item_units u
    left join lateral (
      select li.loadout from public.loadout_items li
       where li.unit_id = u.id
       limit 1
    ) held on true
   where u.user_id = p_user_id;
$$;

-- How many bag slots the bag uses, counted as bankSlotsUsed counts them
-- (packages/shared/src/items.ts): one per stackable item id, one per copy of
-- anything else. `p_in`: copies counted as in the bag anyway (about to land
-- in it); `p_out`: copies counted as out of it (about to leave it).
-- Parity: bankSlotsUsed skips items whose category isn't "deck". The items
-- table has no category and every catalog item is "deck", so this counts
-- every item; a non-deck item would need a category column here.
create or replace function public.bag_slots_used(
  p_user uuid,
  p_in   uuid[] default '{}',
  p_out  uuid[] default '{}'
)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select count(distinct case when coalesce(i.stackable, false)
                             then 'stack:' || u.item_id
                             else u.id::text end)::int
    from public.item_units u
    left join public.items i on i.id = u.item_id
   where u.user_id = p_user
     and not (u.id = any(p_out))
     and (u.id = any(p_in)
          or (u.equipped_slot is null
              and not exists (select 1 from public.loadout_items li
                               where li.unit_id = u.id)));
$$;

-- Whether `p_in` landing in the bag and `p_out` leaving it would grow the bag
-- past its capacity (bankCapacity: 18 slots and 12 per expansion, which are
-- BANK_SLOT_COUNT and BANK_EXPANSION_SLOTS by hand). A change that doesn't
-- grow the bag is always allowed, so nothing gets stuck in a bag that's over
-- capacity already. growsBagPastCapacity (items.ts) is the same rule.
create or replace function public.bag_would_overflow(
  p_user uuid,
  p_in   uuid[],
  p_out  uuid[] default '{}'
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select a.after > 18 + 12 * h.bank_expansions
           and a.after > public.bag_slots_used(p_user)
      from public.herzies h,
           lateral (select public.bag_slots_used(p_user, p_in, p_out) as after) a
     where h.user_id = p_user), false);
$$;

-- The loadouts as the clients read them (LoadoutState):
--   { active: 1|2, inactive: [{slot, unitId, itemId}] | null }
-- `inactive` is null until the first switch (loadout 2 starts empty). A copy
-- that's gone, or that's no longer this herzie's, reads as unitId null.
create or replace function public.loadout_state_json(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'active', h.active_loadout,
    'inactive', case
      when h.loadout_switched_at is null then null
      else coalesce((
        select jsonb_agg(jsonb_build_object(
                 'slot', li.slot,
                 'unitId', u.id,
                 'itemId', li.item_id
               ) order by li.slot, li.position)
          from public.loadout_items li
          left join public.item_units u
            on u.id = li.unit_id and u.user_id = li.user_id
         where li.user_id = h.user_id
           and li.loadout <> h.active_loadout), '[]'::jsonb)
    end
  )
    from public.herzies h
   where h.user_id = p_user;
$$;

-- item_state as 00079, plus the loadouts: every inventory response carries
-- them, so the Deck's loadout tabs stay right after any change.
create or replace function public.item_state(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'units', public.item_units_json(p_user_id),
           'inventory', h.inventory_v2,
           'equipped', h.equipped,
           'itemUpgrades', h.item_upgrades,
           'currency', h.currency,
           'loadouts', public.loadout_state_json(p_user_id)
         )
    from public.herzies h
   where h.user_id = p_user_id;
$$;

-- equip_unit as 00106, keeping the bag within capacity now that a copy can
-- come off into it without one leaving it:
--   - a copy the other loadout holds can be put on (it's then worn and
--     held), and taking it off leaves it held, not in the bag;
--   - taking off anything else needs a bag slot: refused 'bag-full' when
--     that would grow the bag past capacity;
--   - putting on a copy that isn't coming out of the bag (a held one, or a
--     worn one changing ground side) needs a bag slot for whatever it
--     displaces that the other loadout doesn't hold, refused the same way.
--     Putting on a bag copy is a swap and always goes through.
create or replace function public.equip_unit(
  p_user_id uuid,
  p_unit_id uuid,
  p_action text,
  p_side text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unit public.item_units;
  v_equipable boolean;
  v_equip_slot text;
  v_min_stage int;
  v_required_class text;
  v_stage int;
  v_class text;
  v_slot text;
  v_others int;
  v_held boolean;
  v_landing uuid[];
begin
  select stage, class into v_stage, v_class
    from public.herzies where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  select * into v_unit
    from public.item_units
   where id = p_unit_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-owned');
  end if;
  v_held := exists (select 1 from public.loadout_items li
                     where li.unit_id = p_unit_id);

  if p_action = 'unequip' then
    if v_unit.equipped_slot is null then
      return jsonb_build_object('ok', false, 'reason', 'not-equipped');
    end if;
    if not v_held and public.bag_would_overflow(p_user_id, array[p_unit_id]) then
      return jsonb_build_object('ok', false, 'reason', 'bag-full');
    end if;
    update public.item_units
       set equipped_slot = null, equipped_at = null
     where id = p_unit_id;
    return jsonb_build_object('ok', true, 'state', public.item_state(p_user_id));
  end if;

  if p_action <> 'equip' then
    return jsonb_build_object('ok', false, 'reason', 'bad-action');
  end if;

  select equipable, equip_slot, min_stage, required_class
    into v_equipable, v_equip_slot, v_min_stage, v_required_class
    from public.items where id = v_unit.item_id;
  if not coalesce(v_equipable, false) or v_equip_slot is null then
    return jsonb_build_object('ok', false, 'reason', 'no-slot');
  end if;

  if v_stage < coalesce(v_min_stage, 1) then
    return jsonb_build_object('ok', false, 'reason', 'stage-too-low');
  end if;

  if v_required_class is not null and v_class is distinct from v_required_class then
    return jsonb_build_object('ok', false, 'reason', 'class-required');
  end if;

  if v_equip_slot = 'ground' then
    if p_side is null or p_side not in ('left', 'right') then
      return jsonb_build_object('ok', false, 'reason', 'missing-side');
    end if;
    v_slot := 'ground_' || p_side;
  else
    v_slot := v_equip_slot;
  end if;

  if v_unit.equipped_slot is not distinct from v_slot then
    return jsonb_build_object('ok', false, 'reason', 'already-equipped');
  end if;

  -- Checked before anything is changed: this function returns normally on a
  -- rejection, so a partial change would be committed, not rolled back.
  if v_slot = 'modifier' then
    select count(*) into v_others
      from public.item_units
     where user_id = p_user_id
       and equipped_slot = 'modifier'
       and item_id <> v_unit.item_id;
    -- 6 is MAX_MODIFIERS (packages/shared/src/items.ts).
    if v_others >= 6 then
      return jsonb_build_object('ok', false, 'reason', 'max-modifiers');
    end if;
  end if;

  -- Not coming out of the bag: what the updates below take off lands in it,
  -- unless the other loadout holds it.
  if v_unit.equipped_slot is not null or v_held then
    select coalesce(array_agg(u.id), '{}') into v_landing
      from public.item_units u
     where u.user_id = p_user_id
       and u.id <> p_unit_id
       and u.equipped_slot is not null
       and (u.item_id = v_unit.item_id
            or (v_slot <> 'modifier' and u.equipped_slot = v_slot))
       and not exists (select 1 from public.loadout_items li
                        where li.unit_id = u.id);
    if public.bag_would_overflow(p_user_id, v_landing) then
      return jsonb_build_object('ok', false, 'reason', 'bag-full');
    end if;
  end if;

  -- Free whichever copy of this item is currently worn (which may be this one,
  -- being moved between ground sides).
  update public.item_units
     set equipped_slot = null, equipped_at = null
   where user_id = p_user_id
     and item_id = v_unit.item_id
     and equipped_slot is not null;

  -- Displace the incumbent of a single-value slot.
  if v_slot <> 'modifier' then
    update public.item_units
       set equipped_slot = null, equipped_at = null
     where user_id = p_user_id and equipped_slot = v_slot;
  end if;

  update public.item_units
     set equipped_slot = v_slot, equipped_at = now()
   where id = p_unit_id;

  return jsonb_build_object('ok', true, 'state', public.item_state(p_user_id));
end;
$$;

-- Switch to loadout `p_to`, in one locked transaction. Nothing moves into or
-- out of the bag except what can't go on:
--   1. the target's pieces are checked against equip_unit's rules (stage,
--      class, the slot, the modifier cap), in the order they were worn. A
--      piece whose copy is gone or no longer this herzie's is reported
--      `missing`; one that fails a rule is reported `refused` and goes to
--      the bag, so if the bag can't take every refused piece the whole
--      switch is refused ('bag-full') before anything changes;
--   2. what's worn becomes the loadout being left (held), the target's rows
--      go, and the target's pieces are put on.
-- The first switch finds the target empty: what's worn goes to loadout 1
-- and the herzie is left bare.
--   { ok: true, state, loadouts, report: {missing, refused} }
--   { ok: false, reason: 'invalid' | 'same' | 'too-soon' | 'not-found' | 'bag-full' }
create or replace function public.switch_loadout(p_user uuid, p_to smallint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage    int;
  v_class    text;
  v_active   smallint;
  v_switched timestamptz;
  v_piece    record;
  v_def      record;
  v_unit     public.item_units;
  v_ids      uuid[] := '{}';
  v_slots    text[] := '{}';
  v_items    text[] := '{}';
  v_taken    text[] := '{}';
  v_mods     int := 0;
  v_bagged   uuid[] := '{}';
  v_missing  text[] := '{}';
  v_refused  text[] := '{}';
  v_now      timestamptz := now();
begin
  if p_to is null or p_to not in (1, 2) then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  select stage, class, active_loadout, loadout_switched_at
    into v_stage, v_class, v_active, v_switched
    from public.herzies where user_id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;
  if v_active = p_to then
    return jsonb_build_object('ok', false, 'reason', 'same');
  end if;
  -- 1 s is LOADOUT_SWITCH_GAP_MS (packages/shared/src/loadouts.ts): against
  -- click spam flooding Town with look changes.
  if v_switched is not null and v_switched > v_now - interval '1 second' then
    return jsonb_build_object('ok', false, 'reason', 'too-soon');
  end if;

  -- 1. Which of the target's pieces go on. Nothing has changed yet, so a
  -- refusal here leaves everything as it was.
  for v_piece in
    select li.slot, li.unit_id, li.item_id
      from public.loadout_items li
     where li.user_id = p_user and li.loadout = p_to
     -- The single slots first, then the modifiers in the order worn.
     order by (li.slot = 'modifier'), li.position, li.slot
  loop
    select u.* into v_unit
      from public.item_units u
     where u.id = v_piece.unit_id
       and u.user_id = p_user
       and u.item_id = v_piece.item_id;
    if not found then
      v_missing := v_missing || v_piece.item_id;
      continue;
    end if;

    select i.equipable, i.equip_slot, i.min_stage, i.required_class
      into v_def
      from public.items i where i.id = v_piece.item_id;
    if not found
       or not coalesce(v_def.equipable, false)
       or not (v_def.equip_slot = v_piece.slot
               or (v_def.equip_slot = 'ground'
                   and v_piece.slot in ('ground_left', 'ground_right')))
       or v_stage < coalesce(v_def.min_stage, 1)
       or (v_def.required_class is not null
           and v_class is distinct from v_def.required_class)
       -- One worn copy per item.
       or v_piece.item_id = any(v_items)
       -- 6 is MAX_MODIFIERS (packages/shared/src/items.ts).
       or (v_piece.slot = 'modifier' and v_mods >= 6)
       or (v_piece.slot <> 'modifier' and v_piece.slot = any(v_taken))
    then
      v_refused := v_refused || v_piece.item_id;
      -- Worn now, it stays held by the loadout being left; else it's bagged.
      if v_unit.equipped_slot is null then
        v_bagged := v_bagged || v_unit.id;
      end if;
      continue;
    end if;

    v_ids := v_ids || v_unit.id;
    v_slots := v_slots || v_piece.slot;
    v_items := v_items || v_piece.item_id;
    if v_piece.slot = 'modifier' then
      v_mods := v_mods + 1;
    else
      v_taken := v_taken || v_piece.slot;
    end if;
  end loop;

  if public.bag_would_overflow(p_user, v_bagged) then
    return jsonb_build_object('ok', false, 'reason', 'bag-full');
  end if;

  -- 2. The target's rows go (its pieces are worn, or bagged, from here on)
  -- and what's worn becomes the loadout being left. Only the inactive
  -- loadout is ever stored, so v_active normally has no rows to replace.
  delete from public.loadout_items
   where user_id = p_user and loadout in (p_to, v_active);
  insert into public.loadout_items (user_id, loadout, slot, unit_id, item_id, position)
  select p_user, v_active, u.equipped_slot, u.id, u.item_id,
         (row_number() over (
            partition by u.equipped_slot
            order by u.equipped_at nulls first, u.id) - 1)::int
    from public.item_units u
   where u.user_id = p_user and u.equipped_slot is not null;

  update public.item_units
     set equipped_slot = null, equipped_at = null
   where user_id = p_user and equipped_slot is not null;

  -- One statement for all of it (the projection refreshes per statement).
  -- equipped_at steps by a microsecond so the modifiers keep their order.
  update public.item_units u
     set equipped_slot = t.slot,
         equipped_at = v_now + (t.ord * interval '1 microsecond')
    from unnest(v_ids, v_slots) with ordinality as t(id, slot, ord)
   where u.id = t.id and u.user_id = p_user;

  update public.herzies
     set active_loadout = p_to, loadout_switched_at = v_now
   where user_id = p_user;

  return jsonb_build_object(
    'ok', true,
    'state', public.item_state(p_user),
    'loadouts', public.loadout_state_json(p_user),
    'report', jsonb_build_object(
      'missing', to_jsonb(v_missing),
      'refused', to_jsonb(v_refused)
    )
  );
end;
$$;

revoke execute on function public.item_projection(uuid) from public, anon, authenticated;
revoke execute on function public.item_units_json(uuid) from public, anon, authenticated;
revoke execute on function public.bag_slots_used(uuid, uuid[], uuid[]) from public, anon, authenticated;
revoke execute on function public.bag_would_overflow(uuid, uuid[], uuid[]) from public, anon, authenticated;
revoke execute on function public.loadout_state_json(uuid) from public, anon, authenticated;
revoke execute on function public.item_state(uuid) from public, anon, authenticated;
revoke execute on function public.equip_unit(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.switch_loadout(uuid, smallint) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- sync_context as 00140, plus 'loadouts' (the Deck's tabs at launch, when
-- the app reads items from the sync alone) and 'new_titles' (titles not
-- yet handed to the app; processSync takes them with take_new_titles only
-- when there are some, so the common sync costs nothing more).
-- ---------------------------------------------------------------------------
create or replace function public.sync_context(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'herzie', (
      select to_jsonb(h) from public.herzies h where h.user_id = p_user_id
    ),
    'item_units', public.item_units_json(p_user_id),
    'loadouts', public.loadout_state_json(p_user_id),
    'new_titles', (
      select coalesce(jsonb_agg(ht.title_id), '[]'::jsonb)
        from public.herzie_titles ht
       where ht.user_id = p_user_id and not ht.notified
    ),
    'multipliers', (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'name', m.name, 'bonus', m.bonus, 'schedule', m.schedule
        )), '[]'::jsonb)
      from public.multipliers m
      where m.active = true
        and m.starts_at <= now()
        and m.ends_at >= now()
    ),
    'xp_bonuses', (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'id', b.id, 'enabled', b.enabled, 'amount', b.amount, 'cap', b.cap
        )), '[]'::jsonb)
      from public.xp_bonuses b
    ),
    'flags', (
      select coalesce(jsonb_object_agg(g.id, g.enabled), '{}'::jsonb)
      from public.game_flags g
    ),
    'pending_drops', (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'id', d.id, 'item_id', d.item_id, 'dropped_at', d.dropped_at
        ) order by d.dropped_at), '[]'::jsonb)
      from public.pending_drops d
      where d.user_id = p_user_id
    ),
    'active_hunts', (
      select coalesce(
        jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title)), '[]'::jsonb)
      from public.events e
      where e.type = 'song_hunt'
        and e.active = true
        and e.starts_at <= now()
        and e.ends_at >= now()
    ),
    'active_boss', (
      select jsonb_build_object(
        'id', e.id,
        'title', e.title,
        'hatedGenres', coalesce(e.config -> 'hatedGenres', '[]'::jsonb)
      )
      from public.events e
      join public.boss_state bs on bs.event_id = e.id
      where e.type = 'boss_fight'
        and e.active = true
        and e.starts_at <= now()
        and e.ends_at > now()
        and not bs.killed
        and not bs.escaped
      -- spawn_boss_fight guarantees at most one; the order is only there so
      -- that guarantee failing would still pick deterministically.
      order by e.starts_at desc
      limit 1
    ),
    'pending_trade', (
      select jsonb_build_object(
        'tradeId', t.id,
        'fromName', ih.name,
        'fromFriendCode', ih.friend_code
      )
      from public.trades t
      join public.herzies ih on ih.user_id = t.initiator_id
      where t.target_id = p_user_id
        and t.state = 'pending'
        and t.expires_at > now()
      order by t.created_at desc
      limit 1
    ),
    'friend_requests', (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'requestId', fr.id,
          'incoming', fr.to_user_id = p_user_id,
          'name', oh.name,
          'friendCode', oh.friend_code,
          'createdAt', fr.created_at
        ) order by fr.created_at desc), '[]'::jsonb)
      from public.friend_requests fr
      join public.herzies oh
        on oh.user_id = case
             when fr.to_user_id = p_user_id then fr.from_user_id
             else fr.to_user_id
           end
      where (fr.from_user_id = p_user_id or fr.to_user_id = p_user_id)
        and fr.status = 'pending'
    )
  );
$function$;

-- ===========================================================================
-- Held gear stays put. Every RPC that takes copies out of the bag (or names
-- copies it accepts) now also refuses copies the other loadout holds, so
-- a held copy can't be sold, listed, traded, rolled on or spent until it's
-- taken off. Each is its latest definition with only that filter added.
-- execute_trade (00079) takes its copies from trade_offer_unit_ids, so it's
-- covered by that one.
-- ===========================================================================

-- sell_units as 00079: a held copy counts as not there ('not-enough').
create or replace function public.sell_units(p_user_id uuid, p_unit_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wanted int;
  v_found int;
  v_unsellable int;
  v_earned int;
  v_currency int;
begin
  perform 1 from public.herzies where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  select count(distinct x) into v_wanted from unnest(p_unit_ids) x;
  if v_wanted = 0 then
    return jsonb_build_object('ok', false, 'reason', 'not-enough');
  end if;

  select count(*),
         count(*) filter (where coalesce(i.sell_price, 0) <= 0),
         coalesce(sum(coalesce(i.sell_price, 0)), 0)
    into v_found, v_unsellable, v_earned
    from public.item_units u
    left join public.items i on i.id = u.item_id
   where u.user_id = p_user_id and u.id = any(p_unit_ids)
     and not exists (select 1 from public.loadout_items li where li.unit_id = u.id);

  if v_found <> v_wanted then
    return jsonb_build_object('ok', false, 'reason', 'not-enough');
  end if;
  if v_unsellable > 0 then
    return jsonb_build_object('ok', false, 'reason', 'not-sellable');
  end if;

  -- A worn copy that is sold simply stops being worn: it's a row that no
  -- longer exists. (The old rule — selling the last copy of a worn item
  -- unequips it — falls out of that for free.)
  delete from public.item_units
   where user_id = p_user_id and id = any(p_unit_ids);

  update public.herzies
     set currency = currency + v_earned
   where user_id = p_user_id
  returning currency into v_currency;

  return jsonb_build_object(
    'ok', true, 'earned', v_earned, 'newCurrency', v_currency,
    'state', public.item_state(p_user_id));
end;
$$;

-- trade_offer_unit_ids as 00150.
create or replace function public.trade_offer_unit_ids(p_offer jsonb, p_user_id uuid)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_key text;
  v_qty int;
  v_picked uuid[];
begin
  if jsonb_typeof(p_offer -> 'units') = 'array' then
    select coalesce(array_agg(x.uid), '{}'::uuid[]) into v_ids
      from (select distinct (e ->> 'unitId')::uuid as uid
              from jsonb_array_elements(p_offer -> 'units') e) x;

    -- Every offered copy must still be theirs, not worn and not held.
    if (select count(*) from public.item_units u
         where u.id = any(v_ids) and u.user_id = p_user_id
           and u.equipped_slot is null
           and not exists (select 1 from public.loadout_items li where li.unit_id = u.id))
       <> cardinality(v_ids) then
      return null;
    end if;
    return v_ids;
  end if;

  v_ids := '{}'::uuid[];
  for v_key, v_qty in
    select s.k, s.q
      from (select x.k,
                   case when x.v ~ '^[0-9]+$' then x.v::int else 0 end as q
              from jsonb_each_text(
                     coalesce(p_offer -> 'items', '{}'::jsonb)) as x(k, v)) s
     where s.q > 0
  loop
    select coalesce(array_agg(id), '{}'::uuid[]) into v_picked
      from (select id from public.item_units
             where user_id = p_user_id and item_id = v_key and equipped_slot is null
               and not exists (select 1 from public.loadout_items li
                                where li.unit_id = item_units.id)
             order by upgrade_level, acquired_at, id
             limit v_qty) s;
    if cardinality(v_picked) < v_qty then
      return null;
    end if;
    v_ids := v_ids || v_picked;
  end loop;
  return v_ids;
end;
$$;

-- market_list as 00150: a held copy is refused ('held'), and its twins are
-- picked from the bag only.
create or replace function public.market_list(
  p_user_id  uuid,
  p_unit_id  uuid,
  p_price    int,
  p_quantity int default 1
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_listings  constant int := 6;
  c_listing_hours constant int := 48;
  c_max_price     constant int := 1000000;
  c_fee_percent   constant int := 5;
  c_max_stack     constant int := 999;
  c_min_each      constant int := 2;
  v_unit    public.item_units;
  v_item    public.items;
  v_active  int;
  v_ids     uuid[];
  v_listing public.market_listings;
begin
  perform 1 from public.herzies where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  select * into v_unit from public.item_units
   where id = p_unit_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-owned');
  end if;
  if v_unit.equipped_slot is not null then
    return jsonb_build_object('ok', false, 'reason', 'equipped');
  end if;
  if exists (select 1 from public.loadout_items li where li.unit_id = v_unit.id) then
    return jsonb_build_object('ok', false, 'reason', 'held');
  end if;

  select * into v_item from public.items where id = v_unit.item_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-owned');
  end if;

  if p_quantity is null or p_quantity < 1 or p_quantity > c_max_stack then
    return jsonb_build_object('ok', false, 'reason', 'bad-quantity');
  end if;
  if p_quantity > 1 and not v_item.stackable then
    return jsonb_build_object('ok', false, 'reason', 'not-stackable');
  end if;

  -- Anything at or below what the game pays is better sold to the game.
  if p_price is null
     or p_price <= coalesce(v_item.sell_price, 0) * p_quantity
     or p_price < c_min_each * p_quantity then
    return jsonb_build_object('ok', false, 'reason', 'price-too-low');
  end if;
  if p_price > c_max_price then
    return jsonb_build_object('ok', false, 'reason', 'price-too-high');
  end if;

  select count(*) into v_active from public.market_listings
   where seller_id = p_user_id and status = 'active' and expires_at > now();
  if v_active >= c_max_listings then
    return jsonb_build_object('ok', false, 'reason', 'too-many-listings');
  end if;

  -- The picked copy first, then its oldest unworn twins.
  select array_agg(id) into v_ids from (
    select u.id from public.item_units u
     where u.user_id = p_user_id
       and u.item_id = v_unit.item_id
       and u.upgrade_level = v_unit.upgrade_level
       and u.equipped_slot is null
       and not exists (select 1 from public.loadout_items li where li.unit_id = u.id)
     order by (u.id = v_unit.id) desc, u.acquired_at, u.id
     limit p_quantity
     for update
  ) picked;
  if coalesce(array_length(v_ids, 1), 0) < p_quantity then
    return jsonb_build_object('ok', false, 'reason', 'not-enough');
  end if;

  delete from public.item_units where id = any(v_ids);

  insert into public.market_listings
    (seller_id, item_id, upgrade_level, acquired_at, quantity, price, fee,
     expires_at)
  values
    (p_user_id, v_unit.item_id, v_unit.upgrade_level, v_unit.acquired_at,
     p_quantity, p_price, greatest(1, (p_price * c_fee_percent) / 100),
     now() + make_interval(hours => c_listing_hours))
  returning * into v_listing;

  return jsonb_build_object(
    'ok', true,
    'listing', public.market_listing_json(v_listing),
    'state', public.item_state(p_user_id));
end;
$$;

-- apply_item_upgrade as 00088: the die and the pick come from the bag only,
-- and a held card (worn or not) can't be rolled on ('held'): a failed roll
-- would take it out of the other loadout.
create or replace function public.apply_item_upgrade(
  p_user_id uuid,
  p_dice_item_id text,
  p_target_unit_id uuid,
  p_protection_item_id text default null,
  p_roll double precision default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target  public.item_units;
  v_dice_id uuid;
  v_pick_id uuid;
  v_needed  text;
  v_chance  double precision;
  v_result  text;
  v_new     int;
begin
  perform 1 from public.herzies where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  select id into v_dice_id
    from public.item_units
   where user_id = p_user_id and item_id = p_dice_item_id and equipped_slot is null
     and not exists (select 1 from public.loadout_items li
                      where li.unit_id = item_units.id)
   order by acquired_at, id
   limit 1;
  if v_dice_id is null then
    return jsonb_build_object('ok', false, 'reason', 'dice-not-owned');
  end if;

  select * into v_target
    from public.item_units
   where id = p_target_unit_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'target-not-owned');
  end if;
  if exists (select 1 from public.loadout_items li where li.unit_id = v_target.id) then
    return jsonb_build_object('ok', false, 'reason', 'held');
  end if;

  -- 10 is MAX_ITEM_UPGRADE_LEVEL.
  if v_target.upgrade_level >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'max-level');
  end if;

  -- DICE_TIERS, by hand.
  v_needed := case
    when v_target.upgrade_level < 3 then 'power-dice-1'
    when v_target.upgrade_level < 6 then 'power-dice-2'
    else 'power-dice-3'
  end;
  if p_dice_item_id <> v_needed then
    return jsonb_build_object('ok', false, 'reason', 'wrong-dice', 'needed', v_needed);
  end if;

  -- UPGRADE_SUCCESS_CHANCE (packages/shared/src/items.ts), by hand.
  v_chance := case v_target.upgrade_level
    when 6 then 0.6
    when 7 then 0.45
    when 8 then 0.3
    when 9 then 0.2
    else 1
  end;

  -- A pick only matters on a risky roll; on a safe one it's ignored, never
  -- spent.
  if v_chance < 1 and p_protection_item_id is not null then
    select id into v_pick_id
      from public.item_units
     where user_id = p_user_id and item_id = p_protection_item_id
       and item_id = 'safety-pick' and equipped_slot is null
       and not exists (select 1 from public.loadout_items li
                        where li.unit_id = item_units.id)
     order by acquired_at, id
     limit 1;
    if v_pick_id is null then
      return jsonb_build_object('ok', false, 'reason', 'protection-not-owned');
    end if;
  end if;

  if coalesce(p_roll, random()) < v_chance then
    v_result := 'upgraded';
  elsif v_pick_id is not null then
    v_result := 'kept';
  else
    v_result := 'destroyed';
  end if;

  delete from public.item_units where id in (v_dice_id, v_pick_id);

  if v_result = 'upgraded' then
    update public.item_units
       set upgrade_level = upgrade_level + 1
     where id = p_target_unit_id
    returning upgrade_level into v_new;
  elsif v_result = 'kept' then
    v_new := v_target.upgrade_level;
  else
    -- Worn or not, the card is gone; the projection trigger clears its slot.
    delete from public.item_units where id = p_target_unit_id;
    v_new := v_target.upgrade_level;
  end if;

  return jsonb_build_object(
    'ok', true,
    'result', v_result,
    'newLevel', v_new,
    'chance', v_chance,
    'protected', v_pick_id is not null,
    'state', public.item_state(p_user_id));
end;
$$;

-- eat_item as 00113.
CREATE OR REPLACE FUNCTION public.eat_item(
  p_user_id  uuid,
  p_item_id  text,
  p_apply_hp boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  h       public.herzies%rowtype;
  v_heal  int;
  v_unit  uuid;
  v_eff   real;
  v_max   real;
BEGIN
  SELECT * INTO h FROM public.herzies WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-found');
  END IF;

  SELECT c.heal INTO v_heal
    FROM (VALUES
      ('star-candy', 100)
    ) AS c(item_id, heal)
   WHERE c.item_id = p_item_id;
  IF v_heal IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-consumable');
  END IF;

  IF p_apply_hp THEN
    IF h.down THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'down');
    END IF;
    v_max := public.herzie_max_hp(h.level, h.stat_stamina);
    v_eff := public.herzie_effective_hp(
      h.hp, h.hp_at, h.down, h.level, h.stat_stamina, now());
    IF v_eff >= v_max THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'full');
    END IF;
  END IF;

  SELECT id INTO v_unit
    FROM public.item_units
   WHERE user_id = p_user_id
     AND item_id = p_item_id
     AND equipped_slot IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.loadout_items li
                      WHERE li.unit_id = item_units.id)
   LIMIT 1;
  IF v_unit IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'none-left');
  END IF;
  DELETE FROM public.item_units WHERE id = v_unit;

  IF p_apply_hp THEN
    UPDATE public.herzies
       SET hp = least(v_max, v_eff + v_heal),
           hp_at = now() - interval '5 seconds'
     WHERE user_id = p_user_id
    RETURNING * INTO h;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'heal', v_heal,
    'vitals', public.herzie_vitals_json(
      h.hp, h.hp_at, h.down, h.level, h.stat_stamina),
    'state', public.item_state(p_user_id));
END;
$$;

-- buy_from_merchant as 00100: treats are paid from the bag only.
CREATE OR REPLACE FUNCTION public.buy_from_merchant(
  p_user_id  uuid,
  p_event_id uuid,
  p_item_id  text,
  p_quantity int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_type     text;
  v_entry    jsonb;
  v_price    int;
  v_total    int;
  v_limit    int;
  v_sold     int;
  v_bought   int;
  v_cost     int;
  v_currency int;
  v_spent    int;
BEGIN
  PERFORM 1 FROM public.herzies WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-found');
  END IF;

  IF p_quantity IS NULL OR p_quantity < 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad-quantity');
  END IF;

  SELECT e.type INTO v_type
    FROM public.events e
   WHERE e.id = p_event_id
     AND e.type IN ('merchant', 'treat_trader')
     AND e.active
     AND e.starts_at <= now()
     AND e.ends_at > now();
  IF v_type IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-live');
  END IF;

  SELECT s INTO v_entry
    FROM public.events e,
         jsonb_array_elements(coalesce(e.config -> 'stock', '[]')) s
   WHERE e.id = p_event_id
     AND s ->> 'itemId' = p_item_id
   LIMIT 1;
  IF v_entry IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-sold-here');
  END IF;

  v_price := (v_entry ->> 'price')::int;
  v_total := nullif(v_entry ->> 'totalStock', '')::int;
  v_limit := nullif(v_entry ->> 'perPlayerLimit', '')::int;
  IF v_price IS NULL OR v_price <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-sold-here');
  END IF;

  INSERT INTO public.merchant_sales (event_id, item_id)
  VALUES (p_event_id, p_item_id)
  ON CONFLICT DO NOTHING;

  SELECT sold INTO v_sold
    FROM public.merchant_sales
   WHERE event_id = p_event_id AND item_id = p_item_id
     FOR UPDATE;

  IF v_total IS NOT NULL AND v_sold + p_quantity > v_total THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'sold-out');
  END IF;

  SELECT coalesce(max(quantity), 0) INTO v_bought
    FROM public.merchant_purchases
   WHERE event_id = p_event_id AND user_id = p_user_id AND item_id = p_item_id;

  IF v_limit IS NOT NULL AND v_bought + p_quantity > v_limit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'limit-reached');
  END IF;

  v_cost := v_price * p_quantity;

  IF v_type = 'treat_trader' THEN
    -- Paid in treats, unworn copies only. The herzie row lock above
    -- serializes this against any other spend of the same copies.
    SELECT count(*) INTO v_spent
      FROM public.item_units
     WHERE user_id = p_user_id
       AND item_id = 'trick-or-treat'
       AND equipped_slot IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.loadout_items li
                        WHERE li.unit_id = item_units.id);
    IF v_spent < v_cost THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient-treats');
    END IF;

    DELETE FROM public.item_units
     WHERE id IN (
       SELECT id FROM public.item_units
        WHERE user_id = p_user_id
          AND item_id = 'trick-or-treat'
          AND equipped_slot IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.loadout_items li
                           WHERE li.unit_id = item_units.id)
        LIMIT v_cost
          FOR UPDATE
     );
    -- Belt and braces: every other path that removes units takes the herzie
    -- lock too, but a short delete must never sell at a discount.
    GET DIAGNOSTICS v_spent = ROW_COUNT;
    IF v_spent < v_cost THEN
      RAISE EXCEPTION 'treat spend removed % of % treats', v_spent, v_cost;
    END IF;
  ELSE
    SELECT currency INTO v_currency FROM public.herzies WHERE user_id = p_user_id;
    IF v_currency < v_cost THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient-funds');
    END IF;

    UPDATE public.herzies
       SET currency = currency - v_cost
     WHERE user_id = p_user_id
    RETURNING currency INTO v_currency;
  END IF;

  INSERT INTO public.item_units (user_id, item_id)
  SELECT p_user_id, p_item_id FROM generate_series(1, p_quantity);

  UPDATE public.merchant_sales
     SET sold = sold + p_quantity
   WHERE event_id = p_event_id AND item_id = p_item_id;

  INSERT INTO public.merchant_purchases (event_id, user_id, item_id, quantity)
  VALUES (p_event_id, p_user_id, p_item_id, p_quantity)
  ON CONFLICT (event_id, user_id, item_id)
  DO UPDATE SET quantity = public.merchant_purchases.quantity + excluded.quantity;

  -- newCurrency is null for a treat_trader: coins were not touched.
  RETURN jsonb_build_object(
    'ok', true, 'spent', v_cost, 'newCurrency', v_currency,
    'state', public.item_state(p_user_id));
END;
$$;

revoke execute on function public.sell_units(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.trade_offer_unit_ids(jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.market_list(uuid, uuid, int, int) from public, anon, authenticated;
revoke execute on function public.apply_item_upgrade(uuid, text, uuid, text, double precision)
  from public, anon, authenticated;
revoke execute on function public.eat_item(uuid, text, boolean) from public, anon, authenticated;
revoke execute on function public.buy_from_merchant(uuid, uuid, text, int) from public, anon, authenticated;

-- ===========================================================================
-- Backfill: everything already reached, and Original Pressing for every
-- herzie that played before titles. Left un-notified, so the app's first
-- sync hands them over together (one summary, not a toast each).
-- ===========================================================================
insert into public.herzie_titles (user_id, title_id)
select h.user_id, 'original-pressing' from public.herzies h
on conflict (user_id, title_id) do nothing;

do $$
declare
  r record;
begin
  for r in select user_id from public.herzies loop
    perform public.refresh_titles(r.user_id);
  end loop;
end;
$$;
