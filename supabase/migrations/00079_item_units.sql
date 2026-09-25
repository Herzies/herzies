-- Per-unit item identity.
--
-- Until now an owned item was only a count against its catalog id
-- (herzies.inventory_v2 = {itemId: count}) and a dice-upgrade level was only a
-- property of the item TYPE (herzies.item_upgrades = {itemId: level}). There
-- was no such thing as "this copy", so upgrading one Box of Boom upgraded
-- every Box of Boom, and a trade could not carry an upgrade with the card.
--
-- item_units is now the source of truth: one row per owned copy, carrying its
-- own upgrade level and equipped slot. The three old columns on herzies
-- (inventory_v2, item_upgrades, equipped) are kept, but as DERIVED
-- projections that a trigger recomputes whenever a user's units change — see
-- refresh_item_projection. Every existing reader of them (friend lookup,
-- capacity checks, /sync, desktop clients that predate this change) keeps
-- working untouched, and because they are only ever written by that trigger
-- they can never drift from the units. A guard trigger makes any direct write
-- to them an error instead of a silent divergence.

create table public.item_units (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.herzies(user_id) on delete cascade,
  -- No FK to items(id): inventory_v2 and pending_drops never had one either,
  -- and the catalog lives partly in TypeScript.
  item_id       text not null,
  -- 3 is MAX_ITEM_UPGRADE_LEVEL (packages/shared/src/items.ts). SQL can't
  -- import that constant, so the two are kept in sync by hand, exactly like
  -- GROUND_DROP_CAP and BANK_SLOT_COUNT.
  upgrade_level int not null default 0 check (upgrade_level between 0 and 3),
  -- null = sitting in the bank. The values are EQUIPPED_SLOTS plus 'modifier'
  -- (packages/shared/src/items.ts); a CHECK here catches an RPC bug rather than
  -- letting a typo'd slot silently wear nothing.
  equipped_slot text check (
    equipped_slot is null or equipped_slot in (
      'head', 'face', 'body', 'scenery', 'ground_left', 'ground_right',
      'color', 'modifier'
    )
  ),
  -- When it was equipped: orders the modifier list, which used to be an array
  -- whose order was the order you equipped in.
  equipped_at   timestamptz,
  -- Tie-breaker for "pick a copy for me" (oldest first), deterministic.
  acquired_at   timestamptz not null default now()
);

create index item_units_user_id_idx on public.item_units (user_id);

-- At most one copy of a given item can be worn at once. This has always been
-- the rule (applyEquip refused an id that was already equipped); it is now
-- structural, so equipping a second copy is a swap rather than a second
-- simultaneous equip that would double a stat.
create unique index item_units_one_worn_per_item_uidx
  on public.item_units (user_id, item_id)
  where equipped_slot is not null;

-- A single-value slot holds one unit. 'modifier' is excluded on purpose: many
-- different items share it, capped at MAX_MODIFIERS, which an index can't
-- express — equip_unit enforces that cap under the row lock.
create unique index item_units_single_slot_uidx
  on public.item_units (user_id, equipped_slot)
  where equipped_slot is not null and equipped_slot <> 'modifier';

-- Locked down like pending_drops: no policies, so anon/authenticated get
-- nothing. Only the SECURITY DEFINER functions below and the service-role
-- clients ever touch it.
alter table public.item_units enable row level security;


-- ---------------------------------------------------------------------------
-- Projection: what the three legacy columns say, derived from the units.
-- ---------------------------------------------------------------------------

-- inventory   {itemId: count}
-- upgrades    {itemId: level}, only ids with a nonzero level. An id with copies
--             at different levels can't be one number, so it reports the worn
--             copy's level (what stats are computed from) or, if none is worn,
--             the best one owned. Only clients that predate per-unit levels
--             read this; anything current reads the units.
-- equipped    {slot: itemId} plus modifier: [itemId] in the order equipped.
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

-- Writes the projection onto the herzies rows, skipping rows already correct
-- so an unrelated unit change doesn't churn the row.
create or replace function public.refresh_item_projection(p_user_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.herzies h
     set inventory_v2  = p.j -> 'inventory',
         item_upgrades = p.j -> 'upgrades',
         equipped      = p.j -> 'equipped'
    from (select u as user_id, public.item_projection(u) as j
            from unnest(p_user_ids) as u) p
   where h.user_id = p.user_id
     and (h.inventory_v2, h.item_upgrades, h.equipped)
         is distinct from
         (p.j -> 'inventory', p.j -> 'upgrades', p.j -> 'equipped');
end;
$$;

-- The units as the clients read them.
create or replace function public.item_units_json(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', u.id,
           'itemId', u.item_id,
           'upgradeLevel', u.upgrade_level,
           'equippedSlot', u.equipped_slot
         ) order by u.acquired_at, u.id), '[]'::jsonb)
    from public.item_units u
   where u.user_id = p_user_id;
$$;

-- Everything a client needs to redraw after any inventory mutation: the units
-- themselves, the legacy-shaped views older clients still read, and coins.
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
           'currency', h.currency
         )
    from public.herzies h
   where h.user_id = p_user_id;
$$;

revoke execute on function public.item_projection(uuid) from public, anon, authenticated;
revoke execute on function public.refresh_item_projection(uuid[]) from public, anon, authenticated;
revoke execute on function public.item_units_json(uuid) from public, anon, authenticated;
revoke execute on function public.item_state(uuid) from public, anon, authenticated;
-- ---------------------------------------------------------------------------
-- Backfill: expand the old count/level/equip columns into one row per copy.
--
-- Runs before any trigger exists, so it doesn't fire the projection refresh.
-- ---------------------------------------------------------------------------

-- What `equipped` MEANS, whatever historical shape it was stored in — the same
-- reading normalizeEquipped (packages/shared/src/items.ts) applies in code:
-- only the real slot keys count, empty/null values are nothing, and a
-- `modifier` that is a bare string (a legacy shape) is a one-item list. Both the
-- backfill below and its verification read `equipped` through this, so they
-- can't disagree about what a stray shape meant. (Production holds none of
-- these; a dev or staging database might.)
create function pg_temp.norm_equipped(e jsonb) returns jsonb
language sql immutable as $$
  select coalesce((
           select jsonb_object_agg(x.key, x.value)
             from jsonb_each(
                    case when jsonb_typeof(e) = 'object'
                         then e else '{}'::jsonb end) x
            where x.key in ('head', 'face', 'body', 'scenery',
                            'ground_left', 'ground_right', 'color')
              and jsonb_typeof(x.value) = 'string'
              and x.value <> '""'::jsonb
         ), '{}'::jsonb)
      || coalesce((
           select jsonb_build_object('modifier', jsonb_agg(m.v order by m.ord))
             from (
               select t.v, t.ord
                 from jsonb_array_elements(
                        case
                          when jsonb_typeof(e -> 'modifier') = 'array'
                            then e -> 'modifier'
                          when jsonb_typeof(e -> 'modifier') = 'string'
                            then jsonb_build_array(e -> 'modifier')
                          else '[]'::jsonb
                        end
                      ) with ordinality as t(v, ord)
                where jsonb_typeof(t.v) = 'string' and t.v <> '""'::jsonb
             ) m
           having count(*) > 0
         ), '{}'::jsonb);
$$;

-- 1. One unit per owned copy.
insert into public.item_units (user_id, item_id)
select h.user_id, e.key
  from public.herzies h,
       lateral jsonb_each_text(
         case when jsonb_typeof(h.inventory_v2) = 'object'
              then h.inventory_v2 else '{}'::jsonb end
       ) e,
       lateral generate_series(
         1, case when e.value ~ '^[0-9]+$' then e.value::int else 0 end
       ) g;

-- 2. Worn state. For each equipped (slot, item id) pick one copy of that item
--    to be the worn one. Copies were interchangeable before, so which one is
--    arbitrary — but the choice is made here, first, because the upgrade
--    level below has to follow it.
with norm as (
  select h.user_id, pg_temp.norm_equipped(h.equipped) as eq
    from public.herzies h
),
wanted as (
  select n.user_id, e.value as item_id, e.key as slot, 0 as ord
    from norm n, lateral jsonb_each_text(n.eq) e
   where e.key <> 'modifier'
  union all
  select n.user_id, m.item_id, 'modifier', m.ord::int
    from norm n,
         lateral jsonb_array_elements_text(
           coalesce(n.eq -> 'modifier', '[]'::jsonb)
         ) with ordinality as m(item_id, ord)
),
picked as (
  select distinct on (w.user_id, w.item_id)
         w.slot, w.ord,
         (select u.id from public.item_units u
           where u.user_id = w.user_id and u.item_id = w.item_id
           order by u.id limit 1) as unit_id
    from wanted w
   order by w.user_id, w.item_id, w.ord
)
update public.item_units u
   set equipped_slot = p.slot,
       equipped_at   = now() + (p.ord * interval '1 millisecond')
  from picked p
 where u.id = p.unit_id;

-- 3. Upgrade levels. The old model recorded a level per item id and never
--    which copy earned it, so there is no recoverable answer for an unworn
--    item — the level goes on one copy of it, arbitrarily. For a WORN item
--    it goes on the worn copy, which is not arbitrary: getHerzieStats has
--    always applied the id's level to whatever was worn, so this keeps every
--    player's current stats exactly as they were.
update public.item_units u
   set upgrade_level = l.lvl
  from (
    select h.user_id, e.key as item_id,
           (case when e.value ~ '^[0-9]+$' then e.value::int else 0 end) as lvl
      from public.herzies h,
           lateral jsonb_each_text(
             case when jsonb_typeof(h.item_upgrades) = 'object'
                  then h.item_upgrades else '{}'::jsonb end
           ) e
  ) l
 where l.lvl > 0
   and u.id = (
     select u2.id from public.item_units u2
      where u2.user_id = l.user_id and u2.item_id = l.item_id
      order by (u2.equipped_slot is not null) desc, u2.id
      limit 1
   );


-- ---------------------------------------------------------------------------
-- Verify: the units must reproduce the columns they replace, exactly. Any
-- mismatch aborts the whole migration rather than shipping a quiet change to
-- someone's inventory.
-- ---------------------------------------------------------------------------
do $verify$
declare
  v_inventory_bad int;
  v_upgrades_bad  int;
  v_equipped_bad  int;
  v_orphans       int;
begin
  -- Legacy inventory without zero-count keys (nothing meaningful lives there).
  select count(*) into v_inventory_bad
    from public.herzies h
   where coalesce((
           select jsonb_object_agg(x.k, x.v)
             from jsonb_each(h.inventory_v2) as x(k, v)
            where (x.v::text)::int > 0
         ), '{}'::jsonb)
         is distinct from (public.item_projection(h.user_id) -> 'inventory');
  if v_inventory_bad > 0 then
    raise exception 'item_units backfill: % herzies do not match inventory_v2', v_inventory_bad;
  end if;

  select count(*) into v_upgrades_bad
    from public.herzies h
   where coalesce((
           select jsonb_object_agg(x.k, x.v)
             from jsonb_each(h.item_upgrades) as x(k, v)
            where (x.v::text)::int > 0
         ), '{}'::jsonb)
         is distinct from (public.item_projection(h.user_id) -> 'upgrades');
  if v_upgrades_bad > 0 then
    raise exception 'item_units backfill: % herzies do not match item_upgrades', v_upgrades_bad;
  end if;

  -- Equipped ids the player doesn't actually own can't be represented (there
  -- is no copy to wear). They are dropped, and counted here so it shows in the
  -- migration output rather than vanishing.
  select count(*) into v_orphans
    from public.herzies h,
         lateral (
           select e.value as item_id
             from jsonb_each_text(pg_temp.norm_equipped(h.equipped)) e
            where e.key <> 'modifier'
           union all
           select m.value
             from jsonb_array_elements_text(
                    coalesce(pg_temp.norm_equipped(h.equipped) -> 'modifier',
                             '[]'::jsonb)) m
         ) w
   where coalesce((h.inventory_v2 ->> w.item_id)::int, 0) <= 0;
  if v_orphans > 0 then
    raise notice 'item_units backfill: dropped % equipped item(s) the player did not own', v_orphans;
  end if;

  -- Users with an orphan legitimately differ; everyone else must match.
  select count(*) into v_equipped_bad
    from public.herzies h
   where pg_temp.norm_equipped(h.equipped)
         is distinct from (public.item_projection(h.user_id) -> 'equipped')
     and not exists (
       select 1
         from (
           select e.value as item_id
             from jsonb_each_text(pg_temp.norm_equipped(h.equipped)) e
            where e.key <> 'modifier'
           union all
           select m.value
             from jsonb_array_elements_text(
                    coalesce(pg_temp.norm_equipped(h.equipped) -> 'modifier',
                             '[]'::jsonb)) m
         ) w
        where coalesce((h.inventory_v2 ->> w.item_id)::int, 0) <= 0
     );
  if v_equipped_bad > 0 then
    raise exception 'item_units backfill: % herzies do not match equipped', v_equipped_bad;
  end if;
end;
$verify$;

-- Leave the legacy columns in the canonical shape the projection produces. For
-- a row that is already canonical (all of production's) this writes nothing —
-- refresh_item_projection skips rows that already match — but a stray legacy
-- shape (a scalar `modifier`, null slots, an unknown key, an equipped item the
-- player doesn't own) would otherwise stay as it was until that player's copies
-- next changed. Runs here, before the guard trigger exists, since that trigger
-- rejects any write to these columns made outside the projection itself.
select public.refresh_item_projection(coalesce(array_agg(user_id), '{}'::uuid[]))
  from public.herzies;
-- ---------------------------------------------------------------------------
-- Keep the legacy columns derived.
-- ---------------------------------------------------------------------------

-- Statement-level with transition tables: a grant of 50 copies recomputes the
-- projection once, not fifty times.
create or replace function public.item_units_refresh_trg()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct user_id) into v_ids from new_rows;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct user_id) into v_ids from old_rows;
  else
    select array_agg(distinct user_id) into v_ids
      from (select user_id from new_rows
            union
            select user_id from old_rows) s;
  end if;

  if v_ids is not null then
    perform public.refresh_item_projection(v_ids);
  end if;
  return null;
end;
$$;

create trigger item_units_refresh_ins
  after insert on public.item_units
  referencing new table as new_rows
  for each statement execute function public.item_units_refresh_trg();

create trigger item_units_refresh_del
  after delete on public.item_units
  referencing old table as old_rows
  for each statement execute function public.item_units_refresh_trg();

create trigger item_units_refresh_upd
  after update on public.item_units
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.item_units_refresh_trg();

-- A write to the derived columns from anywhere but the projection above is a
-- bug: the units are the truth, so the write would be silently overwritten the
-- next time that player's units change. Fail loudly instead. The projection's
-- own UPDATE runs one trigger level deep (inside the item_units trigger);
-- anything at depth 1 is a direct write.
create or replace function public.herzies_guard_item_projection()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() < 2 and (
       new.inventory_v2  is distinct from old.inventory_v2
    or new.item_upgrades is distinct from old.item_upgrades
    or new.equipped      is distinct from old.equipped
  ) then
    raise exception
      'inventory_v2, item_upgrades and equipped are derived from item_units and cannot be written directly';
  end if;
  return new;
end;
$$;

create trigger herzies_guard_item_projection
  before update on public.herzies
  for each row execute function public.herzies_guard_item_projection();

revoke execute on function public.item_units_refresh_trg() from public, anon, authenticated;
revoke execute on function public.herzies_guard_item_projection() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Every way an item comes into existence now mints units.
-- ---------------------------------------------------------------------------

-- Dead since drops replaced direct CD grants (00053): nothing calls it, and it
-- writes inventory_v2 directly, which is now derived and would throw. Removed
-- rather than left as a trap.
drop function if exists public.grant_cds(uuid, integer, integer);

-- Signature unchanged: settle_boss_fight calls this from a pg_cron job with no
-- request/response path to surface a failure, so it must keep working as-is.
create or replace function public.grant_inventory_item(
  p_user_id uuid,
  p_item_id text,
  p_quantity integer default 1
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_quantity is null or p_quantity < 1 then
    return;
  end if;
  -- Guarded on the herzie existing, like the UPDATE it replaces: granting to a
  -- user with no herzie was a silent no-op, not an FK error.
  insert into public.item_units (user_id, item_id)
  select p_user_id, p_item_id
    from generate_series(1, p_quantity)
   where exists (select 1 from public.herzies where user_id = p_user_id);
end;
$$;

-- Signature and return unchanged (the collect-drop edge function deploys on
-- its own). The DELETE ... RETURNING is still the atomic claim — first caller
-- wins, a racing second one deletes nothing and gets NULL.
--
-- The new unit takes the drop's own id. That id was already unique and already
-- named this exact pickup, so identity now runs unbroken from "landed on the
-- ground" to "sits in the bank" instead of being thrown away at collection.
create or replace function public.collect_pending_drop(p_user_id uuid, p_drop_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item_id text;
begin
  delete from public.pending_drops
   where id = p_drop_id and user_id = p_user_id
  returning item_id into v_item_id;

  if v_item_id is null then
    return null;
  end if;

  insert into public.item_units (id, user_id, item_id)
  values (p_drop_id, p_user_id, v_item_id);

  return v_item_id;
end;
$$;

-- Only the direct-grant branch changes. Idempotency, the ground branch and its
-- deliberate bypass of GROUND_DROP_CAP (a paid item must never be silently
-- destroyed by a full ground) are exactly as they were.
create or replace function public.fulfill_store_order(
  p_session_id text,
  p_event_id text,
  p_to_ground boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.store_orders;
begin
  select * into o from public.store_orders
    where stripe_checkout_session_id = p_session_id for update;

  if not found then return false; end if;
  -- Idempotency, covering both branches below: Stripe retries webhooks, and
  -- the test-mode checkout path calls this directly. The row lock above plus
  -- this check is what stops a retry paying out twice.
  if o.status = 'completed' then return true; end if;

  if o.grant_item_id is not null then
    if p_to_ground then
      -- Deliberately a direct INSERT and NOT roll_pending_drops: that function
      -- enforces GROUND_DROP_CAP and returns 0 when the ground is full, which
      -- for a paid item would silently destroy the purchase. A bought item is
      -- never subject to the drop cap. Do not "consolidate" these two.
      insert into public.pending_drops (user_id, item_id)
      values (o.user_id, o.grant_item_id);
    else
      insert into public.item_units (user_id, item_id)
      values (o.user_id, o.grant_item_id);
    end if;
  else
    update public.herzies
      set currency = currency + o.currency_amount
      where user_id = o.user_id;
  end if;

  update public.store_orders
    set status = 'completed', stripe_event_id = p_event_id, completed_at = now()
    where id = o.id;

  return true;
end;
$$;


-- ---------------------------------------------------------------------------
-- Dice: an upgrade now targets one specific copy.
-- ---------------------------------------------------------------------------

-- The old (uuid, text, text) form keyed the level by item id, which is the bug
-- this migration exists to fix.
drop function if exists public.apply_item_upgrade(uuid, text, text);

-- Consumes one unworn die and raises ONE unit's level. Dice are fungible so any
-- one will do; the target is the whole point, hence a unit id. "Is this a
-- statted card" is not checkable here (stats live only in the TS catalog), so
-- the API route checks that before calling this — same split as before.
create or replace function public.apply_item_upgrade(
  p_user_id uuid,
  p_dice_item_id text,
  p_target_unit_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.item_units;
  v_dice_id uuid;
  v_new int;
begin
  perform 1 from public.herzies where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  select id into v_dice_id
    from public.item_units
   where user_id = p_user_id and item_id = p_dice_item_id and equipped_slot is null
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

  -- 3 is MAX_ITEM_UPGRADE_LEVEL (packages/shared/src/items.ts).
  if v_target.upgrade_level >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'max-level');
  end if;

  delete from public.item_units where id = v_dice_id;
  update public.item_units
     set upgrade_level = upgrade_level + 1
   where id = p_target_unit_id
  returning upgrade_level into v_new;

  return jsonb_build_object(
    'ok', true, 'newLevel', v_new, 'state', public.item_state(p_user_id));
end;
$$;


-- ---------------------------------------------------------------------------
-- Sell / buy / equip: were two-round-trip read-then-write routes with no lock
-- at all, so two racing requests could both read the same state and the second
-- write clobber the first. Now one locked transaction each.
-- ---------------------------------------------------------------------------

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
   where u.user_id = p_user_id and u.id = any(p_unit_ids);

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

-- Price comes from the items row, not the caller. Bank capacity is still the
-- caller's pre-check (it lives in shared TS, not here — the same choice
-- fulfill_store_order made, to keep one slot-counting implementation).
create or replace function public.buy_item_units(
  p_user_id uuid,
  p_item_id text,
  p_quantity int
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_price int;
  v_cost int;
  v_currency int;
begin
  perform 1 from public.herzies where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  if p_quantity is null or p_quantity < 1 then
    return jsonb_build_object('ok', false, 'reason', 'bad-quantity');
  end if;

  select buy_price into v_price from public.items where id = p_item_id;
  if v_price is null or v_price <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'not-for-sale');
  end if;

  v_cost := v_price * p_quantity;
  select currency into v_currency from public.herzies where user_id = p_user_id;
  if v_currency < v_cost then
    return jsonb_build_object('ok', false, 'reason', 'insufficient-funds');
  end if;

  update public.herzies
     set currency = currency - v_cost
   where user_id = p_user_id
  returning currency into v_currency;

  insert into public.item_units (user_id, item_id)
  select p_user_id, p_item_id from generate_series(1, p_quantity);

  return jsonb_build_object(
    'ok', true, 'spent', v_cost, 'newCurrency', v_currency,
    'state', public.item_state(p_user_id));
end;
$$;

-- Wear or remove one specific copy. Reasons mirror applyEquip's rejections.
--
-- Equipping a copy of an item whose OTHER copy is worn is a swap, not a second
-- equip. Equipping into an occupied single-value slot displaces the incumbent
-- (swapping a hat shouldn't need an explicit unequip first); the displaced
-- copy just returns to the bank.
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
  v_slot text;
  v_others int;
begin
  perform 1 from public.herzies where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  select * into v_unit
    from public.item_units
   where id = p_unit_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-owned');
  end if;

  if p_action = 'unequip' then
    if v_unit.equipped_slot is null then
      return jsonb_build_object('ok', false, 'reason', 'not-equipped');
    end if;
    update public.item_units
       set equipped_slot = null, equipped_at = null
     where id = p_unit_id;
    return jsonb_build_object('ok', true, 'state', public.item_state(p_user_id));
  end if;

  if p_action <> 'equip' then
    return jsonb_build_object('ok', false, 'reason', 'bad-action');
  end if;

  select equipable, equip_slot into v_equipable, v_equip_slot
    from public.items where id = v_unit.item_id;
  if not coalesce(v_equipable, false) or v_equip_slot is null then
    return jsonb_build_object('ok', false, 'reason', 'no-slot');
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


-- ---------------------------------------------------------------------------
-- Trading.
--
-- An offer is now a list of specific units, chosen up front, snapshotted as
-- {units: [{unitId, itemId, upgradeLevel}], items: {itemId: count}, currency}
-- so the other player sees "+3 Box of Boom" without a live query into your
-- inventory. `items` is the same offer counted by id, kept for older clients
-- that only understand that shape.
-- ---------------------------------------------------------------------------

-- The unit ids an offer actually moves, or NULL if it can't be honoured.
-- Must run with the offerer's herzies row already locked.
--
-- Two shapes: `units` (what current clients send), and an `items`-only map
-- from a client that predates this — resolved here to that player's plainest
-- unworn copies first, so a lower-level card is offered before a better one.
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

    -- Every offered copy must still be theirs and must not be worn: nothing
    -- else stops you trading away the hat you have on.
    if (select count(*) from public.item_units
         where id = any(v_ids) and user_id = p_user_id and equipped_slot is null)
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

-- Rewritten from scratch rather than patched: the transfer loop itself changes
-- shape, which can't be expressed as an anchor+insert splice the way 00059 and
-- 00078 patched it. Every behaviour of the version it replaces is kept:
--   * trade row locked; must be both_locked, both accepted, not expired
--   * both herzies rows locked in a fixed order (initiator_id < target_id) so
--     two simultaneous trades between the same pair can't deadlock
--   * currency sufficiency checked for both sides
--   * returns false (never raises) on anything that stops the trade
--   * trade marked completed
-- New: an upgrade level travels with its card (it's a column on the row that
-- moves), and a worn copy can't be traded away.
create or replace function public.execute_trade(trade_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.trades;
  init_currency integer;
  targ_currency integer;
  init_offer_currency integer;
  targ_offer_currency integer;
  init_units uuid[];
  targ_units uuid[];
begin
  select * into t from public.trades where id = trade_id for update;
  if not found or t.state != 'both_locked' then return false; end if;
  if not t.initiator_accepted or not t.target_accepted then return false; end if;
  if t.expires_at is not null and t.expires_at < now() then return false; end if;

  init_offer_currency := coalesce((t.initiator_offer ->> 'currency')::int, 0);
  targ_offer_currency := coalesce((t.target_offer ->> 'currency')::int, 0);

  if t.initiator_id < t.target_id then
    select currency into init_currency
      from public.herzies where user_id = t.initiator_id for update;
    select currency into targ_currency
      from public.herzies where user_id = t.target_id for update;
  else
    select currency into targ_currency
      from public.herzies where user_id = t.target_id for update;
    select currency into init_currency
      from public.herzies where user_id = t.initiator_id for update;
  end if;

  if init_currency < init_offer_currency then return false; end if;
  if targ_currency < targ_offer_currency then return false; end if;

  init_units := public.trade_offer_unit_ids(t.initiator_offer, t.initiator_id);
  if init_units is null then return false; end if;
  targ_units := public.trade_offer_unit_ids(t.target_offer, t.target_id);
  if targ_units is null then return false; end if;

  update public.item_units
     set user_id = t.target_id, equipped_slot = null, equipped_at = null
   where id = any(init_units) and user_id = t.initiator_id;
  update public.item_units
     set user_id = t.initiator_id, equipped_slot = null, equipped_at = null
   where id = any(targ_units) and user_id = t.target_id;

  update public.herzies
     set currency = init_currency - init_offer_currency + targ_offer_currency
   where user_id = t.initiator_id;
  update public.herzies
     set currency = targ_currency - targ_offer_currency + init_offer_currency
   where user_id = t.target_id;

  update public.trades set state = 'completed', updated_at = now() where id = trade_id;

  return true;
end;
$$;


-- ---------------------------------------------------------------------------
-- /sync's context now carries the units. to_jsonb(h) still supplies the
-- legacy-shaped columns; the units are a separate table so they have to be
-- attached explicitly — a new herzies column would have appeared for free,
-- a new table doesn't.
-- ---------------------------------------------------------------------------
create or replace function public.sync_context(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'herzie', (
      select to_jsonb(h) from public.herzies h where h.user_id = p_user_id
    ),
    'item_units', public.item_units_json(p_user_id),
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
$$;


-- ---------------------------------------------------------------------------
-- Catalog: First Edition Card stops being stackable.
--
-- It was the one item both stackable and statted (+10 luck), the only case
-- where a stack could split into two tiles once its copies' levels diverged.
-- Unstacked, it behaves like every other card — one slot per copy — which
-- restores the invariant that a stackable item never carries per-unit state,
-- so slot counting needs no new rules.
-- ---------------------------------------------------------------------------
update public.items set stackable = false where id = 'first-edition';


-- Creating a function grants EXECUTE to PUBLIC. Everything here is server-only
-- (service role / other SECURITY DEFINER functions), so revoke it, restating
-- the roles explicitly as 00052 explains. CREATE OR REPLACE on the functions
-- that already existed kept their previous privileges, so only the genuinely
-- new signatures need it.
revoke execute on function public.apply_item_upgrade(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.sell_units(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.buy_item_units(uuid, text, int) from public, anon, authenticated;
revoke execute on function public.equip_unit(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.trade_offer_unit_ids(jsonb, uuid) from public, anon, authenticated;
