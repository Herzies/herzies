-- Boss fights ranked by contribution, not damage alone.
--
-- A herzie's contribution is the damage it dealt plus ten times the HP it
-- healed (Soothing Drones) or blocked (its Cymbrella's own share, not Def's).
-- A heal is worth far more than a hit: a Bard restores ~100 HP in the time
-- a damage dealer hits for ~4,000. The weight mirrors
-- CONTRIBUTION_SUPPORT_WEIGHT in packages/shared/src/combat.ts.
--
-- The Town server reports support in the same batches as damage (00102),
-- so it's applied once per batch id too. Support never touches the boss's
-- HP. Everything that ranks a fight's herzies ranks by contribution now:
-- the leaderboard, the payout's top tier, the statue and the end screen.

alter table public.boss_damage
  add column if not exists healing real not null default 0,
  add column if not exists blocked real not null default 0;

create or replace function public.boss_contribution(
  p_damage real,
  p_healing real,
  p_blocked real
)
returns real
language sql
immutable
set search_path = ''
as $$
  select (coalesce(p_damage, 0)
          + 10 * (coalesce(p_healing, 0) + coalesce(p_blocked, 0)))::real;
$$;

-- p_damage: [{"uid", "damage", "healing"?, "blocked"?}, ...]. As in 00102;
-- a row's support is added whether or not the boss is still standing (a
-- heal in the killing batch still counts), and leaves boss_state alone.
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
      if v_damage > 0 then
        select * into v_res from public.deal_boss_damage(
          p_event, (v_item ->> 'uid')::uuid, v_damage);
      end if;
      if v_healing > 0 or v_blocked > 0 then
        insert into public.boss_damage (event_id, user_id, healing, blocked)
        select p_event, (v_item ->> 'uid')::uuid, v_healing, v_blocked
         where exists (select 1 from public.events e
                        where e.id = p_event and e.type = 'boss_fight')
        on conflict (event_id, user_id) do update
          set healing = public.boss_damage.healing + excluded.healing,
              blocked = public.boss_damage.blocked + excluded.blocked;
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

-- The leaderboard: as in 00073, by contribution, with each part.
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
         bd.damage,
         (bd.healing + bd.blocked)::real,
         public.boss_contribution(bd.damage, bd.healing, bd.blocked),
         row_number() over (
           order by public.boss_contribution(bd.damage, bd.healing, bd.blocked) desc,
                    bd.user_id)
    from public.boss_damage bd
    join public.herzies h on h.user_id = bd.user_id
   where bd.event_id = p_event_id
     and public.boss_contribution(bd.damage, bd.healing, bd.blocked) > 0
   order by 5 desc, bd.user_id
   limit p_limit;
$$;

-- As in 00105: everyone who contributed is paid; the top tier by
-- contribution.
create or replace function public.settle_boss_fight(p_event_id uuid default null)
returns int as $$
declare
  v_event       record;
  v_participant record;
  v_config      jsonb;
  v_base_item   text;
  v_top_item    text;
  v_top_count   int;
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
    v_config    := v_event.config;
    v_base_item := v_config ->> 'rewardItemId';
    v_top_item  := v_config ->> 'topRewardItemId';
    v_top_count := coalesce((v_config ->> 'topCount')::int, 3);

    for v_participant in
      select bd.user_id,
             row_number() over (
               order by public.boss_contribution(bd.damage, bd.healing, bd.blocked) desc,
                        bd.user_id) as rnk
        from public.boss_damage bd
       where bd.event_id = v_event.id
         and public.boss_contribution(bd.damage, bd.healing, bd.blocked) > 0
    loop
      insert into public.event_claims (event_id, user_id)
      values (v_event.id, v_participant.user_id)
      on conflict (event_id, user_id) do nothing;

      -- Conflict means this player was already paid on an earlier run.
      if not found then
        continue;
      end if;

      insert into public.pending_drops (user_id, item_id, dropped_at, source_event)
      select v_participant.user_id, i.item_id, v_lands, v_event.id
        from (values
                (1, v_base_item),
                (2, case when v_participant.rnk <= v_top_count
                         then v_top_item end)
             ) as i(n, item_id)
       where i.item_id is not null
         and exists (
           select 1 from public.herzies h
            where h.user_id = v_participant.user_id
         )
       order by i.n;

      v_paid := v_paid + 1;
    end loop;

    update public.boss_state set settled = true where event_id = v_event.id;
    update public.events set active = false where id = v_event.id;
  end loop;

  return v_paid;
end;
$$ language plpgsql security definer set search_path = '';

-- The statue (00109): the top contributor of the last fight that's over.
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
    select d.user_id, d.event_id, d.damage,
           public.boss_contribution(d.damage, d.healing, d.blocked) as score
      from over o
      join public.boss_damage d on d.event_id = o.id
     where public.boss_contribution(d.damage, d.healing, d.blocked) > 0
       and not (d.user_id = any (coalesce(p_skip, '{}')))
     order by o.over_at desc, score desc, d.user_id
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

-- The end screen (00110): the top three, with their looks, and the asked-
-- about herzies' places, by contribution.
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
           bd.damage,
           bd.healing + bd.blocked as heal,
           row_number() over (
             order by public.boss_contribution(bd.damage, bd.healing, bd.blocked) desc,
                      bd.user_id) as rank
      from public.boss_damage bd
      join public.herzies h on h.user_id = bd.user_id
     where bd.event_id = p_event
       and public.boss_contribution(bd.damage, bd.healing, bd.blocked) > 0
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

revoke execute on function public.boss_contribution(real, real, real) from public, anon, authenticated;
revoke execute on function public.apply_boss_damage_batch(text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.boss_leaderboard(uuid, int) from public, anon, authenticated;
revoke execute on function public.settle_boss_fight(uuid) from public, anon, authenticated;
revoke execute on function public.boss_champion_json(uuid[]) from public, anon, authenticated;
revoke execute on function public.boss_results_json(uuid, uuid[]) from public, anon, authenticated;
