-- The boss's cave stays open until the fight is over. Before: a lobby that
-- nobody had locked closed two minutes past its start, and once the roster
-- locked nobody else could come in. Now anyone on their feet can walk in at
-- any time while the boss is up; a late arrival joins the roster and the
-- boss's health grows to fit them (join_boss_fight).

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
  order by e.starts_at desc
  limit 1;
$$;

-- As 00122's, minus the unlocked fight that expired two minutes in: an
-- empty cave now waits for whoever comes first.
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
       and e.ends_at <= now()
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

-- Herzies who walked in after the lock. They join the roster (paid like
-- anyone in when the boss falls) and the boss's health and max grow by what
-- the bigger roster adds (bossMaxHp: per player × n^0.9). Idempotent: one
-- already on the roster, in or out, changes nothing (out is out for good).
-- Returns lock_boss_fight's shape (the whole roster, out or not), or null if there is no running locked fight.
create or replace function public.join_boss_fight(
  p_event      uuid,
  p_uids       uuid[],
  p_per_player real default null
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
  v_old    double precision;
  v_new    double precision;
begin
  select bs.* into v_state
    from public.boss_state bs
   where bs.event_id = p_event
     for update;
  if not found or v_state.locked_at is null
     or v_state.killed or v_state.escaped then
    return null;
  end if;

  select e.config into v_config
    from public.events e
   where e.id = p_event and e.type = 'boss_fight';
  if not found then
    return null;
  end if;

  insert into public.boss_participants (event_id, user_id, locked_at)
  select p_event, r.u, now()
    from (select distinct u
            from unnest(coalesce(p_uids, '{}')) as u
           limit 40) r
   where exists (select 1 from public.herzies h where h.user_id = r.u)
  on conflict do nothing;
  get diagnostics v_n = row_count;

  if v_n > 0 then
    v_per := least(greatest(coalesce(
      nullif(v_config ->> 'hpPerPlayer', '')::real,
      p_per_player,
      130000), 100), 10000000);
    select count(*) into v_n
      from public.boss_participants bp
     where bp.event_id = p_event and bp.status = 'in';
    v_old := v_state.max_hp;
    v_new := floor(v_per::double precision * power(greatest(v_n, 1), 0.9) + 0.5);
    if v_new > v_old then
      update public.boss_state
         set hp = hp + (v_new - v_old), max_hp = v_new
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
revoke execute on function public.join_boss_fight(uuid, uuid[], real) from public, anon, authenticated;
