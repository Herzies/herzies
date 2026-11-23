-- ===========================================================================
-- 00154 — Wilds loot
--
-- What there is to get on the Wilds besides a fight (packages/shared/src/
-- wilds-loot.ts): its bits (crafting materials found nowhere else), the
-- Wilds instruments crafted from them, tuning an instrument with them, a
-- cache every few minutes, +50% listening XP while there, and one card from
-- the bag dropped where a herzie is taken down.
--
-- The Wilds room (packages/town-server) has no database access: it judges
-- reach and who's first, and reports through town-vitals, which lands
-- everything here. Each of its actions is idempotent on an id the room makes
-- (a drop's uuid, a cache's wildsCacheId), so a retried report changes
-- nothing. Crafting and tuning come from the web API, which reads the costs
-- off the shared tables (WILDS_RECIPES, tuningCost) and hands them in: the
-- RPCs only check and take, under the herzie's row lock.
--
-- A dropped card lies in escrow (wilds_drops), out of everyone's bag, until
-- it's taken or goes back. The room returns the ones nobody took after
-- WILDS_DROP.lifeMs; if the room dies first, any wilds RPC and the owner's
-- own next sync (sync_context) put them back, so nothing is ever lost.
--
-- Apply with or after the desktop release that knows the Wilds loot: an
-- older app can't see a card it dropped (it just goes missing until it comes
-- back), a cache, or the new items' art.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The items. Bits are ordinary stackable cards (one bag tile a stack, as
-- bag_slots_used already counts them); the instruments aren't stackable.
-- No buy price, and none come from the normal pools
-- (NON_DROPPABLE_ITEM_IDS).
-- ---------------------------------------------------------------------------
insert into public.items
  (id, name, description, rarity, sell_price, stackable, equipable,
   equip_slot, min_stage, required_class)
values
  ('tonewood', 'Tonewood',
   'Crafting bit from the Wilds. Crafts Wilds instruments and tunes instruments up to +3 at the Crafting Station.',
   'common', 3, true, false, null, null, null),
  ('sky-string', 'Sky String',
   'Crafting bit from the Wilds. Crafts Wilds instruments and tunes instruments from +2 to +5 at the Crafting Station.',
   'uncommon', 8, true, false, null, null, null),
  ('storm-hide', 'Storm Hide',
   'Crafting bit from the Wilds. Crafts Wilds instruments and tunes instruments from +3 to +6 at the Crafting Station.',
   'rare', 25, true, false, null, null, null),
  ('resonite', 'Resonite',
   'Crafting bit from the Wilds. Tunes instruments from +5 to +6 at the Crafting Station.',
   'legendary', 80, true, false, null, null, null),
  ('wildwood-lute', 'Wildwood Lute',
   'Carved from Wilds tonewood and strung with sky. It''s never out of tune.',
   'rare', 40, false, true, 'main_hand', 2, 'bard'),
  ('stormcut-discs', 'Stormcut Discs',
   'Pressed in a thunderstorm. They spin with a crackle.',
   'rare', 40, false, true, 'main_hand', 2, 'record_slinger'),
  ('thunderhide-sticks', 'Thunderhide Sticks',
   'Wrapped in storm hide. Every rimshot lands like thunder.',
   'rare', 40, false, true, 'main_hand', 2, 'percussionist'),
  ('storm-cymbal', 'Storm Cymbal',
   'Hammered in the eye of a storm. Rings loud enough to turn a blow.',
   'rare', 40, false, true, 'off_hand', 2, 'percussionist')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- On the Wilds: until when a herzie counts as there (the listening bonus).
-- The room says so for everyone in it every half minute (town-vitals'
-- report.wilds); a word lasts WILDS_PRESENCE_MS, a little over two of those.
-- processSync never writes it (herzieToRow doesn't know it).
-- ---------------------------------------------------------------------------
alter table public.herzies
  add column if not exists wilds_until timestamptz;

-- ---------------------------------------------------------------------------
-- Cards dropped on the Wilds, in escrow. `id` is the room's drop id. The
-- copy keeps its own id (unit_id), level and age: whoever ends up with it
-- gets that very copy back. `settled`: null while it lies there, then
-- 'taken' (by taken_by) or 'returned' (to its owner). No foreign key on the
-- killer or the taker: a herzie that's deleted shouldn't take the record
-- with it. The owner's does cascade: a deleted herzie's card has no one to
-- go back to.
-- ---------------------------------------------------------------------------
create table if not exists public.wilds_drops (
  id            uuid primary key,
  event_id      uuid references public.events(id) on delete set null,
  unit_id       uuid not null,
  item_id       text not null,
  upgrade_level int not null default 0,
  acquired_at   timestamptz not null,
  owner_id      uuid not null references public.herzies(user_id) on delete cascade,
  killer_id     uuid,
  x             real not null,
  z             real not null,
  dropped_at    timestamptz not null default now(),
  settled       text check (settled in ('taken', 'returned')),
  taken_by      uuid,
  settled_at    timestamptz,
  constraint wilds_drops_settled check ((settled is null) = (settled_at is null))
);
-- The lazy settlement's two questions: what's due, and what's one owner's.
create index if not exists wilds_drops_due_idx
  on public.wilds_drops (dropped_at) where settled is null;
create index if not exists wilds_drops_owner_idx
  on public.wilds_drops (owner_id) where settled is null;
alter table public.wilds_drops enable row level security;
revoke all on public.wilds_drops from anon, authenticated;

-- Caches opened: once each (the id is wildsCacheId: event, number, shard).
create table if not exists public.wilds_caches (
  id        text primary key,
  event_id  uuid references public.events(id) on delete set null,
  opened_by uuid not null,
  opened_at timestamptz not null default now()
);
alter table public.wilds_caches enable row level security;
revoke all on public.wilds_caches from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Whether `p_event` is the Wilds event that's on now, as events-active
-- counts one live (00153: type 'wilds', active, now within its window).
create or replace function public.wilds_event_live(p_event uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.events e
     where e.id = p_event
       and e.type = 'wilds'
       and e.active
       and e.starts_at <= now()
       and e.ends_at > now());
$$;

-- Drops `p_ids` (null: every one overdue) that still lie on the ground go
-- back to their owners, bag room or not (it was theirs, and leaving can't be
-- refused). `p_owner`: only that owner's. Overdue is a minute past
-- WILDS_DROP.lifeMs (2 min): the room returns its own on its half-minute
-- sweep (and says so to everyone there), so it always gets there first;
-- this is for the ones a room that's gone never will. Returns the ids that
-- went back.
create or replace function public.wilds_return_drops(
  p_ids   uuid[] default null,
  p_owner uuid   default null
)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  -- The update takes each row's lock, so a take racing a return gets the
  -- card or "gone", never both.
  with back as (
    update public.wilds_drops d
       set settled = 'returned', settled_at = now()
     where d.settled is null
       and ((p_ids is null
             and d.dropped_at <= now() - interval '3 minutes')
            or d.id = any(p_ids))
       and (p_owner is null or d.owner_id = p_owner)
    returning d.id, d.unit_id, d.owner_id, d.item_id, d.upgrade_level,
              d.acquired_at
  ), ins as (
    -- Runs whether or not anything reads it (a data-modifying WITH does).
    insert into public.item_units
      (id, user_id, item_id, upgrade_level, acquired_at)
    select b.unit_id, b.owner_id, b.item_id, b.upgrade_level, b.acquired_at
      from back b
  )
  select coalesce(array_agg(b.id), '{}') into v_ids from back b;
  return v_ids;
end;
$$;

-- Spends `p_bits` ({itemId: count}) from the bag, all or nothing. False
-- (and nothing taken) if any is short. Callers hold the herzie's lock.
create or replace function public.wilds_spend_bits(p_user uuid, p_bits jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  r       record;
  v_n     int;
  v_have  int;
  v_taken int;
begin
  for r in select key, value from jsonb_each_text(coalesce(p_bits, '{}'))
  loop
    v_n := r.value::int;
    if v_n is null or v_n < 0 then
      raise exception 'wilds_spend_bits: bad count % for %', r.value, r.key;
    end if;
    select count(*) into v_have
      from public.item_units u
     where u.user_id = p_user and u.item_id = r.key
       and u.equipped_slot is null
       and not exists (select 1 from public.loadout_items li
                        where li.unit_id = u.id);
    if v_have < v_n then
      return false;
    end if;
  end loop;

  for r in select key, value from jsonb_each_text(coalesce(p_bits, '{}'))
  loop
    v_n := r.value::int;
    continue when v_n = 0;
    delete from public.item_units
     where id in (
       select u.id from public.item_units u
        where u.user_id = p_user and u.item_id = r.key
          and u.equipped_slot is null
          and not exists (select 1 from public.loadout_items li
                           where li.unit_id = u.id)
        order by u.acquired_at, u.id
        limit v_n
          for update);
    -- The herzie lock makes a short delete impossible; never spend less.
    get diagnostics v_taken = row_count;
    if v_taken < v_n then
      raise exception 'wilds_spend_bits: took % of % %', v_taken, v_n, r.key;
    end if;
  end loop;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Taken down: one random card from the bag (town-vitals "wildsDrop").
-- Uniform over the bag's tiles — a stackable id is one tile, each copy of
-- anything else one — and from a stack just one copy (the plainest, newest).
-- Never a worn copy or one a loadout holds. Null: the bag is empty, or
-- `p_event` isn't the Wilds event on now. The same id returns the same drop.
-- ---------------------------------------------------------------------------
create or replace function public.wilds_drop(
  p_id     uuid,
  p_event  uuid,
  p_victim uuid,
  p_killer uuid,
  p_x      real,
  p_z      real
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drop  public.wilds_drops%rowtype;
  v_unit  uuid;
  v_item  text;
  v_level int;
  v_age   timestamptz;
begin
  perform public.wilds_return_drops();

  perform 1 from public.herzies where user_id = p_victim for update;
  if not found then
    return null;
  end if;

  -- Under the victim's lock, so a retry racing the first call sees it.
  select * into v_drop from public.wilds_drops where id = p_id;
  if found then
    return jsonb_build_object(
      'id', v_drop.id, 'item', v_drop.item_id, 'level', v_drop.upgrade_level);
  end if;

  if not public.wilds_event_live(p_event) then
    return null;
  end if;

  select t.unit into v_unit
    from (
      select distinct on (b.tile) b.tile, b.id as unit
        from (
          select u.id, u.upgrade_level, u.acquired_at,
                 case when coalesce(i.stackable, false)
                      then 'stack:' || u.item_id
                      else u.id::text end as tile
            from public.item_units u
            left join public.items i on i.id = u.item_id
           where u.user_id = p_victim
             and u.equipped_slot is null
             and not exists (select 1 from public.loadout_items li
                              where li.unit_id = u.id)
        ) b
       order by b.tile, b.upgrade_level, b.acquired_at desc, b.id
    ) t
   order by random()
   limit 1;
  if v_unit is null then
    return null;
  end if;

  delete from public.item_units where id = v_unit
  returning item_id, upgrade_level, acquired_at
    into v_item, v_level, v_age;

  insert into public.wilds_drops
    (id, event_id, unit_id, item_id, upgrade_level, acquired_at, owner_id,
     killer_id, x, z)
  values
    (p_id, p_event, v_unit, v_item, v_level, v_age, p_victim, p_killer,
     p_x, p_z);

  return jsonb_build_object('id', p_id, 'item', v_item, 'level', v_level);
end;
$$;

-- Takes dropped card `p_id` into `p_uid`'s bag (town-vitals "wildsTake").
-- The room has judged reach and the killer's head start. 'bag-full': it
-- would grow the bag past capacity (bag_would_overflow's rule, for a copy
-- that isn't in the bag yet); 'gone': taken, returned, or never dropped.
create or replace function public.wilds_take(p_id uuid, p_uid uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drop  public.wilds_drops%rowtype;
  v_cap   int;
  v_grows boolean;
begin
  perform public.wilds_return_drops();

  select 18 + 12 * h.bank_expansions into v_cap
    from public.herzies h where h.user_id = p_uid for update;
  if not found then
    return jsonb_build_object('ok', false, 'why', 'gone');
  end if;

  select * into v_drop from public.wilds_drops
   where id = p_id and settled is null
     for update;
  if not found then
    return jsonb_build_object('ok', false, 'why', 'gone');
  end if;

  -- It takes a slot unless it's a stackable one the bag has a stack of
  -- already (bag_slots_used's count). Growing past capacity is what's
  -- refused, as bag_would_overflow refuses it (BANK_SLOT_COUNT 18,
  -- BANK_EXPANSION_SLOTS 12, by hand as there).
  select not (coalesce(i.stackable, false) and exists (
           select 1 from public.item_units u
            where u.user_id = p_uid and u.item_id = v_drop.item_id
              and u.equipped_slot is null
              and not exists (select 1 from public.loadout_items li
                               where li.unit_id = u.id)))
    into v_grows
    from (select 1) one
    left join public.items i on i.id = v_drop.item_id;
  if v_grows and public.bag_slots_used(p_uid) + 1 > v_cap then
    return jsonb_build_object('ok', false, 'why', 'bag-full');
  end if;

  update public.wilds_drops
     set settled = 'taken', taken_by = p_uid, settled_at = now()
   where id = p_id;
  insert into public.item_units (id, user_id, item_id, upgrade_level, acquired_at)
  values (v_drop.unit_id, p_uid, v_drop.item_id, v_drop.upgrade_level,
          v_drop.acquired_at);

  return jsonb_build_object(
    'ok', true, 'item', v_drop.item_id, 'level', v_drop.upgrade_level);
end;
$$;

-- Unclaimed drops back to their owners (town-vitals "wildsReturn"). Returns
-- the ids that went back; taken or already returned ones are left out.
create or replace function public.wilds_return(p_ids uuid[])
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  -- The room's own first, so they're reported back; then whatever's
  -- overdue.
  v_ids := public.wilds_return_drops(coalesce(p_ids, '{}'));
  perform public.wilds_return_drops();
  return v_ids;
end;
$$;

-- Opens cache `p_id` for `p_uid` (town-vitals "wildsCache"), once: its
-- loot (`p_items`, rolled by rollCacheLoot) lands on their ground as
-- pending drops, there to be picked up now. Not opened (and nothing given)
-- if it was already, or `p_event` isn't the Wilds event on now.
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
    insert into public.pending_drops (user_id, item_id, dropped_at, source_event)
    select p_uid, x, now(), p_event
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

-- These herzies are on the Wilds for the next WILDS_PRESENCE_MS (town-
-- vitals' report.wilds), if `p_event` is the Wilds event on now. Returns
-- how many were marked.
create or replace function public.wilds_presence(p_event uuid, p_uids uuid[])
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  perform public.wilds_return_drops();
  if not public.wilds_event_live(p_event) then
    return 0;
  end if;
  update public.herzies
     set wilds_until = now() + interval '75 seconds'
   where user_id = any(coalesce(p_uids, '{}'));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- The Wilds claim on a ticket for the Wilds (town-ticket): the Wilds event
-- on now and its window in ms since the epoch, or null.
create or replace function public.open_wilds_json()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'event', e.id,
    'startsAt', (extract(epoch from e.starts_at) * 1000)::bigint,
    'endsAt', (extract(epoch from e.ends_at) * 1000)::bigint
  )
    from public.events e
   where e.type = 'wilds'
     and e.active
     and e.starts_at <= now()
     and e.ends_at > now()
   order by e.starts_at desc
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Crafting and tuning (POST /api/wilds/craft, /api/wilds/tune). The route
-- reads the recipe and the costs off WILDS_RECIPES / tuningCost; these
-- check and take under the herzie's lock. Each first settles the caller's
-- own overdue drops, so a card that's due back counts.
-- ---------------------------------------------------------------------------

-- Crafts `p_item` from a `p_base` copy in the bag (not worn, no loadout
-- holding it: the one furthest along) and `p_bits`. The new instrument
-- keeps the base copy's level. It can't need bag room: a copy of something
-- unstackable leaves for the one that lands.
create or replace function public.wilds_craft(
  p_user uuid,
  p_item text,
  p_base text,
  p_bits jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base  public.item_units%rowtype;
  v_new   uuid;
begin
  perform 1 from public.herzies where user_id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;
  perform public.wilds_return_drops(null, p_user);

  if not exists (select 1 from public.items where id = p_item) then
    return jsonb_build_object('ok', false, 'reason', 'unknown-recipe');
  end if;

  select u.* into v_base
    from public.item_units u
   where u.user_id = p_user and u.item_id = p_base
     and u.equipped_slot is null
     and not exists (select 1 from public.loadout_items li
                      where li.unit_id = u.id)
   order by u.upgrade_level desc, u.acquired_at, u.id
   limit 1
     for update;
  if not found then
    -- Say why: it's on, a loadout holds it, or there's none.
    return jsonb_build_object('ok', false, 'reason',
      case
        when exists (select 1 from public.item_units u
                      where u.user_id = p_user and u.item_id = p_base
                        and u.equipped_slot is not null) then 'worn'
        when exists (select 1 from public.item_units u
                      where u.user_id = p_user and u.item_id = p_base) then 'held'
        else 'no-base'
      end);
  end if;

  if not public.wilds_spend_bits(p_user, p_bits) then
    return jsonb_build_object('ok', false, 'reason', 'not-enough-bits');
  end if;

  delete from public.item_units where id = v_base.id;
  insert into public.item_units (user_id, item_id, upgrade_level)
  values (p_user, p_item, v_base.upgrade_level)
  returning id into v_new;

  return jsonb_build_object(
    'ok', true, 'unitId', v_new, 'state', public.item_state(p_user));
end;
$$;

-- Tunes copy `p_unit` up one level for `p_bits`. `p_tunable`: the items
-- tuning takes (TUNABLE_INSTRUMENTS); `p_cap`: how far it goes
-- (TUNING_MAX_LEVEL); `p_level`: the level the cost was read for — if the
-- copy has moved since (a die, another tune), 'changed' rather than charge
-- the wrong price. Worn or held, a copy may be tuned: it stays where it is.
create or replace function public.wilds_tune(
  p_user    uuid,
  p_unit    uuid,
  p_tunable text[],
  p_cap     int,
  p_level   int,
  p_bits    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unit public.item_units%rowtype;
begin
  perform 1 from public.herzies where user_id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;
  perform public.wilds_return_drops(null, p_user);

  select * into v_unit from public.item_units
   where id = p_unit and user_id = p_user
     for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-owned');
  end if;
  if not (v_unit.item_id = any(p_tunable)) then
    return jsonb_build_object('ok', false, 'reason', 'not-tunable');
  end if;
  if v_unit.upgrade_level >= p_cap then
    return jsonb_build_object('ok', false, 'reason', 'max-level');
  end if;
  if v_unit.upgrade_level <> p_level then
    return jsonb_build_object('ok', false, 'reason', 'changed');
  end if;

  if not public.wilds_spend_bits(p_user, p_bits) then
    return jsonb_build_object('ok', false, 'reason', 'not-enough-bits');
  end if;

  update public.item_units
     set upgrade_level = upgrade_level + 1
   where id = p_unit;

  return jsonb_build_object(
    'ok', true, 'newLevel', v_unit.upgrade_level + 1,
    'state', public.item_state(p_user));
end;
$$;

-- ---------------------------------------------------------------------------
-- sync_context as 00152, plus 'wilds_until' (the listening bonus; also on
-- the herzie row) and, first, the caller's overdue drops going back to
-- them, so a card a dead room never returned comes home on the next sync.
-- That write makes it plpgsql (volatile) rather than a stable SQL query.
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
end;
$function$;

revoke execute on function public.wilds_event_live(uuid) from public, anon, authenticated;
revoke execute on function public.wilds_return_drops(uuid[], uuid) from public, anon, authenticated;
revoke execute on function public.wilds_spend_bits(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.wilds_drop(uuid, uuid, uuid, uuid, real, real) from public, anon, authenticated;
revoke execute on function public.wilds_take(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.wilds_return(uuid[]) from public, anon, authenticated;
revoke execute on function public.wilds_open_cache(text, uuid, uuid, text[]) from public, anon, authenticated;
revoke execute on function public.wilds_presence(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.open_wilds_json() from public, anon, authenticated;
revoke execute on function public.wilds_craft(uuid, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.wilds_tune(uuid, uuid, text[], int, int, jsonb) from public, anon, authenticated;
revoke execute on function public.sync_context(uuid) from public, anon, authenticated;
