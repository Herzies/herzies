-- Tower climbs, and Forbidden Frequency learned.
--
-- - grant_earned_skills (00160) learns the Record Slinger Forbidden
--   Frequency at herzie level 30 (SKILL_DEFS["forbidden-frequency"],
--   skills.ts), and whoever's already there learns it now.
-- - A Tower (an event) is climbed in climbs: tower_reset (the Tower Guard)
--   starts one over at floor 1 with no boons, the month's best floor (the
--   leaderboard) kept. tower_progress keeps the climb's number, the floor
--   it has reached and the boons it has picked (TOWER_BOONS, tower.ts: one
--   pick every 5 floors cleared in a climb).
-- - The ticket's tower claim (open_tower_json) starts a herzie one past
--   the floor their climb has reached, with its boons and number.
-- - tower_grant takes the batch's climb and boons: a batch from a climb
--   since reset never moves the climb now running.
-- - tower_guard_json says where your climb stands (`climb`).

-- ===========================================================================
-- Forbidden Frequency
-- ===========================================================================

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

-- ===========================================================================
-- Climbs
-- ===========================================================================

alter table public.tower_progress
  add column if not exists climb       integer not null default 1,
  add column if not exists climb_floor integer not null default 0,
  add column if not exists boons       text[]  not null default '{}';

alter table public.tower_progress
  drop constraint if exists tower_progress_boons_check;
alter table public.tower_progress
  add constraint tower_progress_boons_check
  check (boons <@ array['speed', 'damage', 'def']::text[]);

-- Nobody loses their place: the climb so far is the one they're on.
update public.tower_progress set climb_floor = best_floor
 where climb_floor < best_floor and climb = 1;

-- ---------------------------------------------------------------------------
-- open_tower_json — the Tower claim for a herzie's ticket: the running Tower
-- event, when it ends (unix seconds), the floor they start on (one past
-- what their climb has reached), the climb's boons and its number. NULL
-- while no Tower is on.
-- ---------------------------------------------------------------------------
create or replace function public.open_tower_json(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'event', e.id,
    'until', extract(epoch from e.ends_at)::bigint,
    'floor', coalesce(tp.climb_floor, 0) + 1,
    'boons', to_jsonb(coalesce(tp.boons, '{}'::text[])),
    'climb', coalesce(tp.climb, 1)
  )
  from public.events e
  left join public.tower_progress tp
    on tp.event_id = e.id and tp.user_id = p_user
  where e.type = 'tower'
    and e.active
    and e.starts_at <= now()
    and e.ends_at > now()
  order by e.starts_at desc
  limit 1;
$$;

revoke execute on function public.open_tower_json(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- tower_grant — as in 00152, and the batch's climb (p_climb) and its boons
-- so far (p_boons). The best floor moves as before, whatever the climb.
-- The climb's floor and boons move only for the climb now running: a batch
-- from before a reset changes neither. Boons are taken only if each is
-- known and the climb has earned that many picks (one per 5 floors);
-- otherwise the old ones stay. No p_climb (a room from before climbs):
-- the climb's floor still moves, its boons don't.
-- ---------------------------------------------------------------------------
drop function if exists public.tower_grant(uuid, uuid, text, integer, integer, text[], integer, integer);

create or replace function public.tower_grant(
  p_user     uuid,
  p_event    uuid,
  p_batch    text,
  p_xp       integer,
  p_cleared  integer,
  p_item_ids text[],
  p_xp_cap   integer,
  p_drop_cap integer,
  p_climb    integer default null,
  p_boons    text[]  default null
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
  v_prog  public.tower_progress%rowtype;
  v_floor int;
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

  -- The climb: only the one running (or, with no climb said, its floor).
  select * into v_prog from public.tower_progress
   where user_id = p_user and event_id = p_event
   for update;
  if found and (p_climb is null or p_climb = v_prog.climb) then
    v_floor := greatest(v_prog.climb_floor, coalesce(p_cleared, 0));
    update public.tower_progress
       set climb_floor = v_floor,
           boons = case
             when p_climb is not null
              and p_boons is not null
              and array_position(p_boons, null) is null
              and p_boons <@ array['speed', 'damage', 'def']::text[]
              and cardinality(p_boons) <= v_floor / 5
               then p_boons
             else boons
           end
     where user_id = p_user and event_id = p_event;
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

revoke execute on function public.tower_grant(uuid, uuid, text, integer, integer, text[], integer, integer, integer, text[])
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- tower_reset — the Tower Guard starts your climb over: the next climb's
-- number, back to floor 1 (none reached), no boons. The best floor stays.
-- { ok: true } or { ok: false, reason: 'not-found' | 'no-tower' }.
-- ---------------------------------------------------------------------------
create or replace function public.tower_reset(p_user uuid, p_event uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.herzies where user_id = p_user) then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  if not exists (
    select 1 from public.events e
     where e.id = p_event and e.type = 'tower' and e.active
       and e.starts_at <= now() and e.ends_at > now()
  ) then
    return jsonb_build_object('ok', false, 'reason', 'no-tower');
  end if;

  insert into public.tower_progress (user_id, event_id, climb)
  values (p_user, p_event, 2)
  on conflict (user_id, event_id) do update
    set climb = public.tower_progress.climb + 1,
        climb_floor = 0,
        boons = '{}';

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.tower_reset(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- tower_guard_json — as in 00121, and `climb`: where your climb in the
-- running Tower stands, { floor, boons } (floor 0, no boons, before you've
-- climbed), or null while no Tower is on.
-- ---------------------------------------------------------------------------
create or replace function public.tower_guard_json(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cur   public.events%rowtype;
  v_last  public.events%rowtype;
  v_win   uuid;
  v_out   jsonb := '{}'::jsonb;
  v_top   jsonb;
  v_you   jsonb;
  v_lastj jsonb;
  v_claim uuid;
  v_item  text;
  v_climb jsonb;
begin
  select * into v_cur from public.events
   where type = 'tower' and active
     and starts_at <= now() and ends_at > now()
   order by starts_at desc limit 1;

  if v_cur.id is not null then
    with board as (
      select user_id, name, level, stage, floor,
             row_number() over (order by floor desc, at asc, user_id) as place
        from public.tower_ranked(v_cur.id)
    )
    select
      coalesce((
        select jsonb_agg(jsonb_build_object(
                 'rank', place, 'name', name, 'level', level,
                 'stage', stage, 'floor', floor) order by place)
          from board where place <= 3), '[]'::jsonb),
      (select jsonb_build_object('rank', place, 'floor', floor)
         from board where user_id = p_user)
      into v_top, v_you;

    v_out := v_out || jsonb_build_object('current', jsonb_build_object(
      'event', v_cur.id,
      'endsAt', extract(epoch from v_cur.ends_at)::bigint,
      'top', v_top,
      'you', v_you,
      'rewardItemId', nullif(v_cur.config ->> 'topRewardItemId', '')));

    select jsonb_build_object('floor', tp.climb_floor, 'boons', to_jsonb(tp.boons))
      into v_climb
      from public.tower_progress tp
     where tp.user_id = p_user and tp.event_id = v_cur.id;
    v_climb := coalesce(v_climb,
      jsonb_build_object('floor', 0, 'boons', '[]'::jsonb));
  else
    v_out := v_out || jsonb_build_object('current', null::jsonb);
  end if;
  v_out := v_out || jsonb_build_object('climb', v_climb);

  -- Last Tower that paid out (one with a reward).
  select * into v_last from public.events
   where type = 'tower' and active and ends_at <= now()
     and coalesce(config ->> 'topRewardItemId', '') <> ''
   order by ends_at desc limit 1;
  if v_last.id is not null then
    v_win := public.tower_winner(v_last.id);
  end if;
  if v_win is not null then
    select jsonb_build_object('event', v_last.id, 'name', r.name, 'floor', r.floor)
      into v_lastj
      from public.tower_ranked(v_last.id) r
     where r.user_id = v_win;
  end if;
  v_out := v_out || jsonb_build_object('last', v_lastj);

  v_claim := public.tower_unclaimed_win(p_user);
  if v_claim is not null then
    select coalesce(nullif(config ->> 'topRewardItemId', ''), 'power-dice-3')
      into v_item from public.events where id = v_claim;
  end if;
  v_out := v_out || jsonb_build_object('reward', jsonb_build_object(
    'eligible', v_claim is not null,
    'event', v_claim,
    'itemId', v_item));

  return v_out;
end;
$$;

revoke execute on function public.tower_guard_json(uuid) from public, anon, authenticated;

-- Whoever has already earned Forbidden Frequency learns it now.
select public.grant_earned_skills(h.user_id)
  from public.herzies h
 where h.class is not null;
