-- ===========================================================================
-- 00159 — What drops on the Wilds stays on the Wilds
--
-- A cache's loot, and what listening drops while you're on the Wilds, lie
-- on the Wilds' ground (pending_drops.wilds), not at your feet wherever you
-- go next as other drops do (the Tower's, the cave's). Still yours, but
-- only to be picked up there: the app shows them only on the Wilds, and a
-- worn spirit's sync sweep only takes them while the room says you're there
-- (wilds_until). Once their event is over (ended, or switched off) they're
-- gone: collect_pending_drop won't hand one over, and the owner's next sync
-- clears them away. They count only against the Wilds' own ground, not the
-- ground listening fills elsewhere (and the other way round).
--
-- A full bag refuses a pickup as ever (collect-drop, and the sync sweep's
-- own check): the drop stays lying where it is.
--
-- Apply before deploying the edge functions that read pending_drops.wilds
-- (sync, attune-crystal), and with or after the desktop release that knows
-- the flag: an older app shows a Wilds drop everywhere, and its pickup off
-- the Wilds is refused as gone.
-- ===========================================================================

alter table public.pending_drops
  add column if not exists wilds boolean not null default false;

-- Every listing below asks "this herzie's Wilds drops"; the clearing asks
-- it on each sync.
create index if not exists pending_drops_wilds_idx
  on public.pending_drops (user_id) where wilds;

-- `p_user`'s Wilds drops whose event is over go. Returns how many.
create or replace function public.wilds_clear_drops(p_user uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  delete from public.pending_drops d
   where d.user_id = p_user
     and d.wilds
     and not public.wilds_event_live(d.source_event);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- roll_pending_drops as 00125, except that while the room says the herzie
-- is on the Wilds, what it rolls lands there: marked wilds, for the event on
-- now. Each ground has its cap of ten on its own.
create or replace function public.roll_pending_drops(p_user_id uuid, p_item_ids text[])
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room     int;
  v_inserted int;
  v_until    timestamptz;
  v_event    uuid;
begin
  -- Serializes against a concurrent sync for this same herzie (see 00065).
  select h.wilds_until into v_until
    from public.herzies h
   where h.user_id = p_user_id
     for update;

  if v_until > now() then
    select e.id into v_event
      from public.events e
     where e.type = 'wilds'
       and e.active
       and e.starts_at <= now()
       and e.ends_at > now()
     order by e.starts_at desc
     limit 1;
  end if;

  select greatest(0, 10 - count(*)) into v_room
    from public.pending_drops d
   where d.user_id = p_user_id
     and d.wilds = (v_event is not null);

  if v_room = 0 then
    return 0;
  end if;

  with ins as (
    insert into public.pending_drops (user_id, item_id, dropped_at, source_event, wilds)
    select p_user_id, x, now() + interval '45 seconds', v_event, v_event is not null
      from (select unnest(p_item_ids) as x limit v_room) s
    returning 1
  )
  select count(*) into v_inserted from ins;

  return v_inserted;
end;
$$;

-- wilds_open_cache as 00154, its loot marked wilds.
create or replace function public.wilds_open_cache(
  p_id    text,
  p_event uuid,
  p_uid   uuid,
  p_items text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drops jsonb;
begin
  perform public.wilds_return_drops();

  if not public.wilds_event_live(p_event)
     or not exists (select 1 from public.herzies where user_id = p_uid) then
    return jsonb_build_object('opened', false, 'drops', '[]'::jsonb);
  end if;

  insert into public.wilds_caches (id, event_id, opened_by)
  values (p_id, p_event, p_uid)
  on conflict (id) do nothing;
  if not found then
    return jsonb_build_object('opened', false, 'drops', '[]'::jsonb);
  end if;

  with ins as (
    insert into public.pending_drops (user_id, item_id, dropped_at, source_event, wilds)
    select p_uid, x, now(), p_event, true
      from unnest(coalesce(p_items, '{}')) x
    returning id, item_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'item', item_id)),
                  '[]'::jsonb)
    into v_drops
    from ins;

  return jsonb_build_object('opened', true, 'drops', v_drops);
end;
$$;

-- collect_pending_drop as 00079, except that a Wilds drop whose event is
-- over isn't handed over (it's as good as gone: NULL).
create or replace function public.collect_pending_drop(p_user_id uuid, p_drop_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item_id text;
begin
  delete from public.pending_drops d
   where d.id = p_drop_id
     and d.user_id = p_user_id
     and (not d.wilds or public.wilds_event_live(d.source_event))
  returning d.item_id into v_item_id;

  if v_item_id is null then
    return null;
  end if;

  insert into public.item_units (id, user_id, item_id)
  values (p_drop_id, p_user_id, v_item_id);

  return v_item_id;
end;
$$;

-- crystal_attune as 00141, its ground listing saying which drops are the
-- Wilds' (and leaving out those whose event is over).
create or replace function public.crystal_attune(
  p_user              uuid,
  p_expected_attunes  integer,
  p_rolls             integer,
  p_items             jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h      public.herzies%rowtype;
  v_xp     integer;
  v_rolls  integer;
  v_given  integer := 0;
begin
  select * into v_h from public.herzies where user_id = p_user for update;
  if not found then
    raise exception 'herzie not found';
  end if;
  if v_h.crystal_attunes is distinct from p_expected_attunes then
    return jsonb_build_object('ok', false, 'reason', 'stale',
      'herzie', to_jsonb(v_h));
  end if;

  v_xp    := greatest(0, floor(v_h.crystal_xp))::integer;
  v_rolls := greatest(0, least(coalesce(p_rolls, 0),
               floor(v_h.crystal_drop_minutes / 10)::integer, 60));

  if v_rolls > 0 and jsonb_typeof(p_items) = 'array' then
    insert into public.pending_drops (user_id, item_id, dropped_at)
    select p_user, i.id, now() + interval '45 seconds'
      from (select e as item_id
              from jsonb_array_elements_text(p_items) with ordinality as t(e, n)
             where n <= v_rolls * 3) as x
      join public.items i on i.id = x.item_id;
    get diagnostics v_given = row_count;
  end if;

  update public.herzies
     set pending_xp           = pending_xp + v_xp,
         crystal_xp           = greatest(0, crystal_xp - v_xp),
         crystal_drop_minutes = greatest(0, crystal_drop_minutes - v_rolls * 10),
         crystal_luck         = case
           when crystal_drop_minutes - v_rolls * 10 <= 0 then null
           else crystal_luck
         end,
         crystal_fill         = 0,
         crystal_attunes      = crystal_attunes + 1
   where user_id = p_user
  returning * into v_h;

  return jsonb_build_object(
    'ok', true,
    'xp', v_xp,
    'rolls', v_rolls,
    'given', v_given,
    'herzie', to_jsonb(v_h),
    'pendingDrops', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', d.id, 'itemId', d.item_id, 'droppedAt', d.dropped_at,
               'wilds', d.wilds
             ) order by d.dropped_at), '[]'::jsonb)
        from public.pending_drops d
       where d.user_id = p_user
         and (not d.wilds or public.wilds_event_live(d.source_event))
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- sync_context as 00154, plus: the caller's Wilds drops whose event is over
-- are cleared first, and each drop listed says whether it's the Wilds'.
-- ---------------------------------------------------------------------------
create or replace function public.sync_context(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
begin
  -- The common sync has nothing due: one probe of a partial index.
  if exists (select 1 from public.wilds_drops d
              where d.owner_id = p_user_id and d.settled is null
                and d.dropped_at <= now() - interval '3 minutes') then
    perform public.wilds_return_drops(null, p_user_id);
  end if;
  -- Likewise: a probe, and a delete only once an event is over.
  if exists (select 1 from public.pending_drops d
              where d.user_id = p_user_id and d.wilds
                and not public.wilds_event_live(d.source_event)) then
    perform public.wilds_clear_drops(p_user_id);
  end if;

  return jsonb_build_object(
    'herzie', (
      select to_jsonb(h) from public.herzies h where h.user_id = p_user_id
    ),
    'wilds_until', (
      select h.wilds_until from public.herzies h where h.user_id = p_user_id
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
          'id', d.id, 'item_id', d.item_id, 'dropped_at', d.dropped_at,
          'wilds', d.wilds
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
end;
$function$;

revoke execute on function public.wilds_clear_drops(uuid) from public, anon, authenticated;
revoke execute on function public.roll_pending_drops(uuid, text[]) from public, anon, authenticated;
revoke execute on function public.wilds_open_cache(text, uuid, uuid, text[]) from public, anon, authenticated;
revoke execute on function public.collect_pending_drop(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.crystal_attune(uuid, integer, integer, jsonb) from public, anon, authenticated;
revoke execute on function public.sync_context(uuid) from public, anon, authenticated;
