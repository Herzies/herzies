-- The cave raid (specs/boss-fight.md).
--
-- The cave opens 15 minutes before a boss event starts (a lobby). At the
-- start the Town server locks the roster to whoever stands in the room
-- (lock_boss_fight) and the boss's health is set from its size. After that
-- only the roster may come in; knocked out, a herzie waits for a Bard
-- (revive_herzie, through apply_boss_revive_batch) or gives up and is out
-- for good (respawn_herzie, mark_boss_out). Everyone still in when the boss
-- falls is paid alike (settle_boss_fight); nobody is paid if everyone in
-- falls (wipe_boss_fight). The statue goes to the top contributor of the
-- last boss that fell, among those still in.
--
-- Damage to the boss's minions counts toward a herzie's contribution
-- (boss_damage.adds) but never touches the boss's health.
--
-- Mirrors: bossMaxHp (packages/shared/src/boss-fight.ts) in
-- lock_boss_fight, BOSS_LOBBY_MS in open_boss_json, CLASS_DEFS[].skills
-- (classes.ts) in choose_class.

-- ---------------------------------------------------------------------------
-- Tables

create table if not exists public.boss_participants (
  event_id  uuid not null references public.events(id) on delete cascade,
  user_id   uuid not null references public.herzies(user_id) on delete cascade,
  status    text not null default 'in' check (status in ('in', 'out')),
  locked_at timestamptz not null default now(),
  out_at    timestamptz,
  primary key (event_id, user_id)
);
alter table public.boss_participants enable row level security;
revoke all on public.boss_participants from anon, authenticated;

alter table public.boss_state
  add column if not exists locked_at timestamptz,
  add column if not exists revives int not null default 0;

alter table public.boss_damage
  add column if not exists adds real not null default 0;

-- One row per fight that locked, written when it ends: for tuning.
create table if not exists public.boss_fight_log (
  event_id    uuid primary key references public.events(id) on delete cascade,
  roster_size int not null,
  locked_at   timestamptz not null,
  ended_at    timestamptz not null,
  outcome     text not null check (outcome in ('victory', 'escaped', 'wiped')),
  stats       jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
alter table public.boss_fight_log enable row level security;
revoke all on public.boss_fight_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The lock

-- p_uids: who's in. p_per_player: the room's health per herzie (the event's
-- own `hpPerPlayer` wins). p_at: when the room locked (unix ms; kept if it's
-- within five minutes of now, so the room's enrage clock survives a
-- restart). Idempotent: a second lock gets the first one back.
create or replace function public.lock_boss_fight(
  p_event      uuid,
  p_uids       uuid[],
  p_per_player real default null,
  p_at         bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state  public.boss_state%rowtype;
  v_config jsonb;
  v_per    real;
  v_n      int;
  v_max    double precision;
  v_at     timestamptz := now();
begin
  select bs.* into v_state
    from public.boss_state bs
   where bs.event_id = p_event
     for update;
  if not found then
    return null;
  end if;

  if v_state.locked_at is null then
    select e.config into v_config
      from public.events e
     where e.id = p_event and e.type = 'boss_fight';
    if not found or v_state.killed or v_state.escaped then
      return null;
    end if;

    if p_at is not null
       and abs(extract(epoch from now()) * 1000 - p_at) < 5 * 60 * 1000 then
      v_at := to_timestamp(p_at / 1000.0);
    end if;

    insert into public.boss_participants (event_id, user_id, locked_at)
    select p_event, r.u, v_at
      from (select distinct u
              from unnest(coalesce(p_uids, '{}')) as u
             limit 40) r
     where exists (select 1 from public.herzies h where h.user_id = r.u)
    on conflict do nothing;
    get diagnostics v_n = row_count;

    if v_n = 0 then
      -- Nobody came: no fight.
      update public.boss_state
         set locked_at = v_at, escaped = true
       where event_id = p_event
      returning * into v_state;
      update public.events set active = false where id = p_event;
    else
      v_per := least(greatest(coalesce(
        nullif(v_config ->> 'hpPerPlayer', '')::real,
        p_per_player,
        130000), 100), 10000000);
      -- bossMaxHp: per player × n^0.9, rounded as Math.round does.
      v_max := floor(v_per::double precision * power(v_n, 0.9) + 0.5);
      update public.boss_state
         set hp = v_max, max_hp = v_max, locked_at = v_at
       where event_id = p_event
      returning * into v_state;
    end if;
  end if;

  return jsonb_build_object(
    'hp', v_state.hp,
    'maxHp', v_state.max_hp,
    'at', round(extract(epoch from v_state.locked_at) * 1000),
    'roster', coalesce((
      select jsonb_agg(bp.user_id order by bp.user_id)
        from public.boss_participants bp
       where bp.event_id = p_event
    ), '[]'::jsonb)
  );
end;
$$;

-- Who the database counts out of a fight.
create or replace function public.boss_out_json(p_event uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(bp.user_id), '[]'::jsonb)
    from public.boss_participants bp
   where bp.event_id = p_event and bp.status = 'out';
$$;

-- Out of a fight for good: gone too long, or gave up. Never once the boss
-- has fallen (whoever was in then stays in, and is paid).
create or replace function public.mark_boss_out(p_event uuid, p_uids uuid[])
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  -- Wait out a killing blow that's committing now, so the update below
  -- (a new snapshot) sees it and leaves everyone in.
  perform 1 from public.boss_state where event_id = p_event for share;
  update public.boss_participants bp
     set status = 'out', out_at = now()
    from public.boss_state bs
   where bp.event_id = p_event
     and bs.event_id = p_event
     and not bs.killed
     and bp.status = 'in'
     and bp.user_id = any (coalesce(p_uids, '{}'));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Everyone in fell: the boss won. No reward, like an escape.
create or replace function public.wipe_boss_fight(p_event uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.boss_state
     set escaped = true
   where event_id = p_event and not killed and not escaped;
  if not found then
    return false;
  end if;
  update public.events set active = false where id = p_event;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Revives

-- p_rows: [{"uid", "hp"}]. Named by p_batch like boss damage (the same
-- ledger), so a retry revives nobody twice. Returns who was refused: those
-- already out (they respawned in town first).
create or replace function public.apply_boss_revive_batch(
  p_batch text,
  p_event uuid,
  p_rows  jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows    integer;
  v_item    jsonb;
  v_uid     uuid;
  v_h       public.herzies%rowtype;
  v_refused jsonb := '[]'::jsonb;
begin
  if p_batch is null or length(p_batch) = 0 or length(p_batch) > 200 then
    raise exception 'bad batch id';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) > 200 then
    raise exception 'bad revive list';
  end if;

  insert into public.boss_damage_batches (batch, event_id)
  values (p_batch, p_event)
  on conflict (batch) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return jsonb_build_object('applied', false, 'refused', '[]'::jsonb);
  end if;

  for v_item in select * from jsonb_array_elements(p_rows) loop
    begin
      v_uid := (v_item ->> 'uid')::uuid;
      if not exists (
        select 1 from public.boss_participants bp
         where bp.event_id = p_event and bp.user_id = v_uid and bp.status = 'in'
      ) then
        v_refused := v_refused || to_jsonb(v_uid);
        continue;
      end if;
      select * into v_h from public.herzies where user_id = v_uid for update;
      if not found or not v_h.down then
        -- Already up (a stale revive): leave its health alone.
        continue;
      end if;
      update public.herzies
         set hp = least(
               public.herzie_max_hp(v_h.level, v_h.stat_stamina),
               greatest(1, coalesce((v_item ->> 'hp')::real, 1))),
             hp_at = now(),
             down = false
       where user_id = v_uid;
      update public.boss_state set revives = revives + 1 where event_id = p_event;
    exception when others then
      -- One bad row never sinks the batch (a retry would fail the same
      -- way, and hold up the whole raid's report): it's skipped, loudly.
      raise warning 'apply_boss_revive_batch: skipped % (%)', v_item, sqlerrm;
      continue;
    end;
  end loop;

  return jsonb_build_object('applied', true, 'refused', v_refused);
end;
$$;

-- As in 00108, and getting back up in town takes a herzie out of any raid
-- it was in that's still going.
create or replace function public.respawn_herzie(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h public.herzies%rowtype;
begin
  -- The raids it's in, locked first (settle takes the boss, then herzies),
  -- so a killing blow committing now is seen and it stays in.
  perform 1
     from public.boss_state bs
     join public.boss_participants bp on bp.event_id = bs.event_id
    where bp.user_id = p_user and bp.status = 'in'
      and not bs.killed and not bs.escaped
      for share of bs;
  select * into h from public.herzies where user_id = p_user for update;
  if not found then
    return null;
  end if;
  if h.down then
    update public.herzies
      set hp = ceil(public.herzie_max_hp(h.level, h.stat_stamina) * 0.5),
          hp_at = now(),
          down = false
      where user_id = p_user
      returning * into h;
    update public.boss_participants bp
       set status = 'out', out_at = now()
      from public.boss_state bs
     where bp.user_id = p_user
       and bp.status = 'in'
       and bs.event_id = bp.event_id
       and not bs.killed
       and not bs.escaped;
  end if;
  return public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level, h.stat_stamina);
end;
$$;

-- ---------------------------------------------------------------------------
-- Damage, with minions

-- As in 00111; a row's `adds` (minion damage) is added to the herzie's
-- contribution like support, and leaves the boss's health alone.
create or replace function public.apply_boss_damage_batch(
  p_batch  text,
  p_event  uuid,
  p_damage jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows    integer;
  v_item    jsonb;
  v_hp      real;
  v_kill    boolean;
  v_res     record;
  v_damage  real;
  v_healing real;
  v_blocked real;
  v_adds    real;
begin
  if p_batch is null or length(p_batch) = 0 or length(p_batch) > 200 then
    raise exception 'bad batch id';
  end if;
  if jsonb_typeof(p_damage) is distinct from 'array'
     or jsonb_array_length(p_damage) > 200 then
    raise exception 'bad damage list';
  end if;

  insert into public.boss_damage_batches (batch, event_id)
  values (p_batch, p_event)
  on conflict (batch) do nothing;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    select bs.hp, bs.killed into v_hp, v_kill
      from public.boss_state bs where bs.event_id = p_event;
    return jsonb_build_object(
      'applied', false, 'hp', v_hp, 'killed', coalesce(v_kill, false));
  end if;

  for v_item in select * from jsonb_array_elements(p_damage) loop
    -- One player's bad row mustn't lose everyone else's.
    begin
      v_damage  := least(greatest(coalesce((v_item ->> 'damage')::real, 0), 0), 1000000);
      v_healing := least(greatest(coalesce((v_item ->> 'healing')::real, 0), 0), 1000000);
      v_blocked := least(greatest(coalesce((v_item ->> 'blocked')::real, 0), 0), 1000000);
      v_adds    := least(greatest(coalesce((v_item ->> 'adds')::real, 0), 0), 1000000);
      if v_damage > 0 then
        select * into v_res from public.deal_boss_damage(
          p_event, (v_item ->> 'uid')::uuid, v_damage);
      end if;
      if v_healing > 0 or v_blocked > 0 or v_adds > 0 then
        insert into public.boss_damage (event_id, user_id, healing, blocked, adds)
        select p_event, (v_item ->> 'uid')::uuid, v_healing, v_blocked, v_adds
         where exists (select 1 from public.events e
                        where e.id = p_event and e.type = 'boss_fight')
        on conflict (event_id, user_id) do update
          set healing = public.boss_damage.healing + excluded.healing,
              blocked = public.boss_damage.blocked + excluded.blocked,
              adds    = public.boss_damage.adds + excluded.adds;
      end if;
    exception when others then
      continue;
    end;
  end loop;

  select bs.hp, bs.killed into v_hp, v_kill
    from public.boss_state bs where bs.event_id = p_event;
  return jsonb_build_object(
    'applied', true, 'hp', v_hp, 'killed', coalesce(v_kill, false));
end;
$$;

-- ---------------------------------------------------------------------------
-- The cave's door

-- The boss as the Town server and ticket function need it, from the lobby's
-- opening (15 minutes before the start) until the boss falls, escapes, or
-- wins. An unlocked fight stays open only two minutes past its start: if no
-- room locked it by then, nobody was there, and nobody can start it late.
create or replace function public.open_boss_json()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'event',       e.id,
    'until',       extract(epoch from e.ends_at)::bigint,
    'hp',          bs.hp,
    'maxHp',       bs.max_hp,
    'starts',      extract(epoch from e.starts_at)::bigint,
    'hated',       case when jsonb_typeof(e.config -> 'hatedGenres') = 'array'
                        then e.config -> 'hatedGenres' end,
    'hpPerPlayer', nullif(e.config ->> 'hpPerPlayer', '')::real,
    'minionFloor', nullif(e.config ->> 'minionFloor', '')::int,
    'locked',      case when bs.locked_at is not null then jsonb_build_object(
                     'at', extract(epoch from bs.locked_at)::bigint,
                     'revives', bs.revives,
                     'roster', coalesce((
                       select jsonb_agg(bp.user_id)
                         from public.boss_participants bp
                        where bp.event_id = e.id and bp.status = 'in'
                     ), '[]'::jsonb)) end
  ))
  from public.events e
  join public.boss_state bs on bs.event_id = e.id
  where e.type = 'boss_fight'
    and e.active
    and e.starts_at - interval '15 minutes' <= now()
    and e.ends_at > now()
    and not bs.killed
    and not bs.escaped
    and bs.hp > 0
    and (bs.locked_at is not null or now() < e.starts_at + interval '2 minutes')
  order by e.starts_at desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Rewards, the board, the end screen and the statue

-- Everyone still in when the boss fell is paid alike: the event's reward and
-- ten rolls of loot. A fight from before the roster (no participants) pays
-- everyone who contributed, as before.
create or replace function public.settle_boss_fight(p_event_id uuid default null)
returns int as $$
declare
  v_event       record;
  v_participant record;
  v_base_item   text;
  v_roster      boolean;
  v_paid        int := 0;
  v_lands       timestamptz := now() + interval '90 seconds';
begin
  for v_event in
    select e.id, e.config
      from public.events e
      join public.boss_state bs on bs.event_id = e.id
     where e.type = 'boss_fight'
       and bs.killed
       and not bs.settled
       and (p_event_id is null or e.id = p_event_id)
  loop
    v_base_item := v_event.config ->> 'rewardItemId';
    v_roster := exists (
      select 1 from public.boss_participants bp where bp.event_id = v_event.id
    );

    for v_participant in
      select bp.user_id
        from public.boss_participants bp
       where v_roster and bp.event_id = v_event.id and bp.status = 'in'
      union
      select bd.user_id
        from public.boss_damage bd
       where not v_roster
         and bd.event_id = v_event.id
         and public.boss_contribution(bd.damage + bd.adds, bd.healing, bd.blocked) > 0
    loop
      insert into public.event_claims (event_id, user_id)
      values (v_event.id, v_participant.user_id)
      on conflict (event_id, user_id) do nothing;

      -- Conflict means this player was already paid on an earlier run.
      if not found then
        continue;
      end if;

      if not exists (
        select 1 from public.herzies h where h.user_id = v_participant.user_id
      ) then
        continue;
      end if;

      if v_base_item is not null then
        insert into public.pending_drops (user_id, item_id, dropped_at, source_event)
        values (v_participant.user_id, v_base_item, v_lands, v_event.id);
      end if;

      insert into public.pending_drops (user_id, item_id, dropped_at, source_event)
      select v_participant.user_id, public.boss_loot_roll(), v_lands, v_event.id
        from generate_series(1, 10);

      v_paid := v_paid + 1;
    end loop;

    update public.boss_state set settled = true where event_id = v_event.id;
    update public.events set active = false where id = v_event.id;
  end loop;

  return v_paid;
end;
$$ language plpgsql security definer set search_path = '';

-- As in 00111, minion damage counted with the boss's.
drop function if exists public.boss_leaderboard(uuid, int);
create function public.boss_leaderboard(
  p_event_id uuid,
  p_limit    int default 5
)
returns table (
  user_id uuid,
  name text,
  damage real,
  heal real,
  contribution real,
  rank bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select bd.user_id,
         h.name,
         (bd.damage + bd.adds)::real,
         (bd.healing + bd.blocked)::real,
         public.boss_contribution(bd.damage + bd.adds, bd.healing, bd.blocked),
         row_number() over (
           order by public.boss_contribution(bd.damage + bd.adds, bd.healing, bd.blocked) desc,
                    bd.user_id)
    from public.boss_damage bd
    join public.herzies h on h.user_id = bd.user_id
   where bd.event_id = p_event_id
     and public.boss_contribution(bd.damage + bd.adds, bd.healing, bd.blocked) > 0
   order by 5 desc, bd.user_id
   limit p_limit;
$$;

-- As in 00111, minion damage counted with the boss's.
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
           h.friend_code,
           h.stage,
           h.equipped,
           bd.damage + bd.adds as damage,
           bd.healing + bd.blocked as heal,
           row_number() over (
             order by public.boss_contribution(bd.damage + bd.adds, bd.healing, bd.blocked) desc,
                      bd.user_id) as rank
      from public.boss_damage bd
      join public.herzies h on h.user_id = bd.user_id
     where bd.event_id = p_event
       and public.boss_contribution(bd.damage + bd.adds, bd.healing, bd.blocked) > 0
       -- Who gave up isn't on the podium (nor on the statue).
       and not exists (select 1 from public.boss_participants bp
                        where bp.event_id = p_event and bp.user_id = bd.user_id
                          and bp.status = 'out')
  )
  select jsonb_build_object(
    'top', coalesce((
      select jsonb_agg(jsonb_build_object(
               'rank', r.rank, 'name', r.name,
               'damage', round(r.damage::numeric), 'heal', round(r.heal::numeric),
               'seed', r.friend_code, 'stage', r.stage, 'equipped', r.equipped)
             order by r.rank)
        from ranked r
       where r.rank <= 3
    ), '[]'::jsonb),
    'you', coalesce((
      select jsonb_object_agg(r.user_id::text, jsonb_build_object(
               'rank', r.rank, 'name', r.name,
               'damage', round(r.damage::numeric), 'heal', round(r.heal::numeric)))
        from ranked r
       where r.user_id = any (coalesce(p_uids, '{}'))
    ), '{}'::jsonb)
  );
$$;

-- The statue: the top contributor of the last boss that fell, among those
-- still in at the end (anyone who contributed, for a fight from before the
-- roster). An escape or a wipe puts nobody up.
create or replace function public.boss_champion_json(p_skip uuid[] default '{}')
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with fallen as (
    select e.id, bs.killed_at as over_at,
           exists (select 1 from public.boss_participants bp
                    where bp.event_id = e.id) as rostered
      from public.events e
      join public.boss_state bs on bs.event_id = e.id
     where e.type = 'boss_fight'
       and bs.killed
  ), top as (
    select d.user_id, d.event_id, d.damage + d.adds as damage,
           public.boss_contribution(d.damage + d.adds, d.healing, d.blocked) as score
      from fallen f
      join public.boss_damage d on d.event_id = f.id
      join public.herzies hz on hz.user_id = d.user_id
     where public.boss_contribution(d.damage + d.adds, d.healing, d.blocked) > 0
       and not (d.user_id = any (coalesce(p_skip, '{}')))
       and (not f.rostered or exists (
             select 1 from public.boss_participants bp
              where bp.event_id = f.id and bp.user_id = d.user_id
                and bp.status = 'in'))
     order by f.over_at desc nulls last, score desc, d.user_id
     limit 1
  )
  select jsonb_build_object(
    'event', t.event_id,
    'damage', t.damage,
    'contribution', t.score,
    'name', h.name,
    'seed', h.friend_code,
    'stage', h.stage,
    'equipped', h.equipped
  )
    from top t
    join public.herzies h on h.user_id = t.user_id;
$$;

-- ---------------------------------------------------------------------------
-- The log

create or replace function public.log_boss_fight(p_event uuid, p_log jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.boss_fight_log (
    event_id, roster_size, locked_at, ended_at, outcome, stats)
  values (
    p_event,
    greatest(0, coalesce((p_log ->> 'roster')::int, 0)),
    to_timestamp(coalesce((p_log ->> 'lockedAt')::bigint, 0) / 1000.0),
    to_timestamp(coalesce((p_log ->> 'endedAt')::bigint, 0) / 1000.0),
    p_log ->> 'outcome',
    p_log - 'event' - 'roster' - 'lockedAt' - 'endedAt' - 'outcome')
  on conflict (event_id) do nothing;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Boss events: health per herzie and minion strength pass through

-- As in 00082, plus `hpPerPlayer` and `minionFloor`; no top tier any more.
-- `maxHp` is now only the placeholder before the lock.
create or replace function public.create_boss_event(
  p_title         text,
  p_description   text,
  p_starts_at     timestamptz,
  p_ends_at       timestamptz,
  p_template      jsonb default '{}',
  p_series_id     uuid default null,
  p_occurrence_at timestamptz default null
)
returns uuid as $$
declare
  -- GENRES minus 'pop' (what every unknown track falls back to).
  v_pool     text[] := array[
    'rock','hip-hop','electronic','jazz','classical','r&b','country',
    'metal','indie','latin','folk','blues','punk','soul'
  ];
  v_template jsonb := coalesce(p_template, '{}');
  v_genres   jsonb;
  v_hp       real;
  v_event_id uuid;
begin
  if exists (
    select 1 from public.events e
     where e.type = 'boss_fight'
       and e.active
       and e.starts_at < p_ends_at
       and e.ends_at > p_starts_at
  ) then
    return null;
  end if;

  v_genres := case
    when jsonb_typeof(v_template -> 'hatedGenres') = 'array'
         and jsonb_array_length(v_template -> 'hatedGenres') > 0
      then v_template -> 'hatedGenres'
    -- unnest in FROM (see 00082).
    else to_jsonb(array(
      select g from unnest(v_pool) as g order by random() limit 3
    ))
  end;

  v_hp := coalesce(nullif(v_template ->> 'maxHp', '')::real, 130000);

  insert into public.events (
    type, title, description, active, starts_at, ends_at, config,
    series_id, occurrence_at
  )
  values (
    'boss_fight',
    p_title,
    p_description,
    true,
    p_starts_at,
    p_ends_at,
    jsonb_strip_nulls(jsonb_build_object(
      'hatedGenres',  v_genres,
      'rewardItemId', coalesce(v_template ->> 'rewardItemId', 'cd'),
      'maxHp',        v_hp,
      'hpPerPlayer',  nullif(v_template ->> 'hpPerPlayer', '')::real,
      'minionFloor',  nullif(v_template ->> 'minionFloor', '')::int
    )),
    p_series_id,
    p_occurrence_at
  )
  returning id into v_event_id;

  insert into public.boss_state (event_id, hp, max_hp)
  values (v_event_id, v_hp, v_hp);

  return v_event_id;
end;
$$ language plpgsql security definer set search_path = '';

-- ---------------------------------------------------------------------------
-- Classes: two skills for Bards and Percussionists

-- As in 00116, granting every skill of the class (CLASS_DEFS[].skills).
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

  return jsonb_build_object('ok', true, 'already', false, 'class', p_class,
    'state', public.item_state(p_user_id));
end;
$$;

-- Everyone already in those classes learns the new skill.
insert into public.herzie_skills (user_id, skill_id)
select h.user_id, case h.class when 'bard' then 'resurrect' else 'taunt' end
  from public.herzies h
 where h.class in ('bard', 'percussionist')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Grants: the service role only.

revoke execute on function public.lock_boss_fight(uuid, uuid[], real, bigint) from public, anon, authenticated;
revoke execute on function public.boss_out_json(uuid) from public, anon, authenticated;
revoke execute on function public.mark_boss_out(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.wipe_boss_fight(uuid) from public, anon, authenticated;
revoke execute on function public.apply_boss_revive_batch(text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.respawn_herzie(uuid) from public, anon, authenticated;
revoke execute on function public.apply_boss_damage_batch(text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.open_boss_json() from public, anon, authenticated;
revoke execute on function public.settle_boss_fight(uuid) from public, anon, authenticated;
revoke execute on function public.boss_leaderboard(uuid, int) from public, anon, authenticated;
revoke execute on function public.boss_results_json(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.boss_champion_json(uuid[]) from public, anon, authenticated;
revoke execute on function public.log_boss_fight(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.create_boss_event(text, text, timestamptz, timestamptz, jsonb, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.choose_class(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- A Bard's resurrect outside a raid (in town, anywhere without a fight): the
-- Town room plays it, then asks for it here. Only a herzie that's down is
-- brought back (a stale request can't knock a standing herzie's health
-- down to the resurrect's share); null for anyone else.
create or replace function public.revive_herzie(p_user uuid, p_hp real)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h public.herzies%rowtype;
begin
  select * into h from public.herzies where user_id = p_user for update;
  if not found or not h.down then
    return null;
  end if;
  update public.herzies
     set hp = least(
           public.herzie_max_hp(h.level, h.stat_stamina),
           greatest(1, coalesce(p_hp, 1))),
         hp_at = now(),
         down = false
   where user_id = p_user
   returning * into h;
  return public.herzie_vitals_json(h.hp, h.hp_at, h.down, h.level, h.stat_stamina);
end;
$$;

revoke execute on function public.revive_herzie(uuid, real) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Production pass

-- Respawning looks up a herzie's raids by user.
create index if not exists boss_participants_user_in
  on public.boss_participants (user_id) where status = 'in';

-- As in 00076, but a locked fight's health was sized for its roster and the
-- room holds it: it can't be changed from the admin page any more.
create or replace function public.admin_set_boss_hp(
  p_event_id uuid,
  p_max_hp   real
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state public.boss_state%rowtype;
  v_dealt real;
begin
  if p_max_hp is null or p_max_hp <= 0 then
    raise exception 'Boss HP must be positive';
  end if;

  select * into v_state
    from public.boss_state
   where event_id = p_event_id
     for update;

  if not found then
    insert into public.boss_state (event_id, hp, max_hp)
    values (p_event_id, p_max_hp, p_max_hp);
    return;
  end if;

  if v_state.max_hp = p_max_hp then
    return;
  end if;

  if v_state.killed then
    raise exception 'Boss is already dead; its HP can no longer change';
  end if;
  if v_state.locked_at is not null then
    raise exception 'The fight has started; its HP is set by the roster';
  end if;

  v_dealt := v_state.max_hp - v_state.hp;
  if p_max_hp <= v_dealt then
    raise exception 'Players have already dealt % damage; HP must be higher', round(v_dealt);
  end if;

  update public.boss_state
     set max_hp = p_max_hp,
         hp     = p_max_hp - v_dealt
   where event_id = p_event_id;
end;
$$;
revoke execute on function public.admin_set_boss_hp(uuid, real)
  from public, anon, authenticated;

-- As in 00073, and a fight nobody locked is over two minutes past its start
-- (the cave sealed then; open_boss_json stops listing it), so the events tab
-- stops showing it.
create or replace function public.resolve_boss_fight()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  with expired as (
    update public.boss_state bs
       set escaped = true
      from public.events e
     where e.id = bs.event_id
       and e.type = 'boss_fight'
       and not bs.killed
       and not bs.escaped
       and (e.ends_at <= now()
            or (bs.locked_at is null
                and e.starts_at + interval '2 minutes' <= now()))
    returning bs.event_id
  )
  select count(*) into v_count from expired;

  update public.events e
     set active = false
    from public.boss_state bs
   where bs.event_id = e.id
     and e.type = 'boss_fight'
     and bs.escaped
     and e.active;

  return v_count;
end;
$$;
revoke execute on function public.resolve_boss_fight() from public, anon, authenticated;
