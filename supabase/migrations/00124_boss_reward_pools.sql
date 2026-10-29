-- Boss reward pools: an event can list pools of items (config.rewardPools)
-- on top of its rewardItemId and the ten random rolls.
--
--   {"itemIds": ["a", "b", "c"], "mode": "all"}
--       everyone still in gets every item in the pool
--   {"itemIds": ["a", "b", "c"], "mode": "chance", "chance": 30}
--       everyone still in has a 30% chance of one of them, picked evenly
--       (10% each); never more than one item per pool
--
-- Items missing from the catalog are skipped, so a typo in a pool can't
-- fail the payout for the whole raid.
--
-- settle_boss_fight is 00122's (checked against prod), plus the pools.

create or replace function public.settle_boss_fight(p_event_id uuid default null)
returns int as $$
declare
  v_event       record;
  v_participant record;
  v_base_item   text;
  v_roster      boolean;
  v_paid        int := 0;
  v_lands       timestamptz := now() + interval '90 seconds';
  v_pools       jsonb;
  v_pool        jsonb;
  v_items       text[];
  v_chance      numeric;
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
    v_pools := case
      when jsonb_typeof(v_event.config -> 'rewardPools') = 'array'
        then v_event.config -> 'rewardPools'
      else '[]'::jsonb
    end;
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

      for v_pool in select value from jsonb_array_elements(v_pools) loop
        v_items := array(
          select x
            from jsonb_array_elements_text(
                   case when jsonb_typeof(v_pool -> 'itemIds') = 'array'
                        then v_pool -> 'itemIds' else '[]'::jsonb end
                 ) as x
           where exists (select 1 from public.items i where i.id = x)
        );
        continue when cardinality(v_items) = 0;

        if v_pool ->> 'mode' = 'all' then
          insert into public.pending_drops (user_id, item_id, dropped_at, source_event)
          select v_participant.user_id, x, v_lands, v_event.id
            from unnest(v_items) as x;
        elsif v_pool ->> 'mode' = 'chance' then
          v_chance := case when jsonb_typeof(v_pool -> 'chance') = 'number'
                           then (v_pool ->> 'chance')::numeric else 0 end;
          if random() * 100 < v_chance then
            insert into public.pending_drops (user_id, item_id, dropped_at, source_event)
            values (
              v_participant.user_id,
              v_items[1 + floor(random() * cardinality(v_items))::int],
              v_lands,
              v_event.id
            );
          end if;
        end if;
      end loop;

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

revoke execute on function public.settle_boss_fight(uuid)
  from public, anon, authenticated;

-- The cave drops a boss's loot in this order: the event's reward first,
-- then what came from its pools, then the random rolls. 00105's, plus the
-- pools.
create or replace function public.boss_loot_json(p_event uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with ev as (
    select e.config ->> 'rewardItemId' as reward,
           coalesce(array(
             select jsonb_array_elements_text(p -> 'itemIds')
               from jsonb_array_elements(
                      case when jsonb_typeof(e.config -> 'rewardPools') = 'array'
                           then e.config -> 'rewardPools' else '[]'::jsonb end
                    ) as p
              where jsonb_typeof(p -> 'itemIds') = 'array'
           ), '{}') as pooled
      from public.events e
     where e.id = p_event
  )
  select coalesce(jsonb_object_agg(per.user_id::text, per.drops), '{}'::jsonb)
    from (
      select d.user_id,
             jsonb_agg(
               jsonb_build_object('id', d.id, 'item', d.item_id)
               order by d.item_id = ev.reward desc nulls last,
                        d.item_id = any (ev.pooled) desc,
                        d.id
             ) as drops
        from public.pending_drops d
        left join ev on true
       where d.source_event = p_event
       group by d.user_id
    ) per;
$$;

revoke execute on function public.boss_loot_json(uuid)
  from public, anon, authenticated;
grant execute on function public.boss_loot_json(uuid) to service_role;

-- A series' fights take its template's reward pools too. 00122's (checked
-- against prod), plus rewardPools.
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
      'rewardPools',  case when jsonb_typeof(v_template -> 'rewardPools') = 'array'
                           then v_template -> 'rewardPools' end,
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

revoke execute on function public.create_boss_event(text, text, timestamptz, timestamptz, jsonb, uuid, timestamptz)
  from public, anon, authenticated;
