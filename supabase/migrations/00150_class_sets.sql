-- The class sets: each class cloak (00123) gets a hat, a neck piece and
-- shoes in its look, and the four together make a set with a bonus for its
-- class (ITEM_SETS in packages/shared/src/items.ts):
--   - The Troubadour (Bard): Troubadour's Plume, Ruff, Mantle and Slippers;
--   - In the Groove (Record Slinger): Groove Cap, Spindle Chain, Groove Cape
--     and Groove Kicks;
--   - Drumhide (Percussionist): Drumhide Helm, Gorget, Cloak and Boots.
-- Each piece is locked to its class (items.required_class, which equip_unit
-- checks), the class cloaks included. Legendary and boss-only, like the
-- cloaks: they come from a boss fight's reward pools (00124, set per fight
-- in the admin), never a listening/Crystal drop nor a boss's random loot
-- (NON_DROPPABLE_ITEM_IDS / BOSS_ONLY_ITEM_IDS in the catalog), so
-- boss_loot_roll (last in 00149) is unchanged. Stats live only in the TS
-- catalog, as ever.
--
-- Every piece needs stage 2 (level 10) or more: the neck pieces and cloaks
-- stage 3 as ever, the hats and shoes stage 2. Eivind's Evasive Pair gets
-- the same stage 2.
--
-- Also gives the neck and back pieces added since 00123 the stage they need:
-- 00145, 00147 and 00149 left items.min_stage NULL, so equip_unit let a
-- herzie with no torso wear them.
--
-- A class lock is now only about who can wear an item: class items, the
-- instruments included, trade and list on the market like anything else.
-- trade_offer_unit_ids (00106) and market_list (00146) lose their
-- required_class checks.
--
-- The catalog rows mirror packages/shared/src/items.ts. Apply with or after
-- the desktop release that knows the items, so older clients never receive
-- them.

INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot, min_stage, required_class)
VALUES
  ('troubadour-plume', 'Troubadour''s Plume', 'A velvet beret with a feather long enough to tickle the back row.',
   'legendary', 500, NULL, false, true, 'head', 2, 'bard'),
  ('troubadour-ruff', 'Troubadour''s Ruff', 'Starched stiff. Keeps your chin up through the sad verses.',
   'legendary', 500, NULL, false, true, 'body', 3, 'bard'),
  ('troubadour-slippers', 'Troubadour''s Slippers', 'Velvet soles for long roads and quiet exits.',
   'legendary', 500, NULL, false, true, 'feet', 2, 'bard'),
  ('groove-cap', 'Groove Cap', 'Worn backwards, like all the best B-sides.',
   'legendary', 500, NULL, false, true, 'head', 2, 'record_slinger'),
  ('spindle-chain', 'Spindle Chain', 'A seven-inch single on a silver chain. Spins when you do.',
   'legendary', 500, NULL, false, true, 'body', 3, 'record_slinger'),
  ('groove-kicks', 'Groove Kicks', 'Laced in red, scuffed from a hundred encores.',
   'legendary', 500, NULL, false, true, 'feet', 2, 'record_slinger'),
  ('drumhide-helm', 'Drumhide Helm', 'A snare with the bottom knocked out. Rings when you''re hit.',
   'legendary', 500, NULL, false, true, 'head', 2, 'percussionist'),
  ('drumhide-gorget', 'Drumhide Gorget', 'Brass-studded hide. Nothing gets past the neck.',
   'legendary', 500, NULL, false, true, 'body', 3, 'percussionist'),
  ('drumhide-boots', 'Drumhide Boots', 'Stamped in four-four. The floor knows you''re coming.',
   'legendary', 500, NULL, false, true, 'feet', 2, 'percussionist')
ON CONFLICT (id) DO NOTHING;

UPDATE public.items
   SET min_stage = 3
 WHERE id IN (
   'ff-pearls-marble',
   'ff-cloak-black',
   'fyllings-necktie',
   'fyllings-cape',
   'eivinds-wings'
 )
   AND min_stage IS NULL;

UPDATE public.items
   SET min_stage = 2
 WHERE id = 'eivinds-evasive-pair'
   AND min_stage IS NULL;

-- The class cloaks join their sets' lock. Herzies of another class already
-- wearing one keep it on; they can't put it back on once it's off.
UPDATE public.items SET required_class = 'bard' WHERE id = 'troubadour-mantle';
UPDATE public.items SET required_class = 'record_slinger' WHERE id = 'groove-cape';
UPDATE public.items SET required_class = 'percussionist' WHERE id = 'drumhide-cloak';

-- As 00106's, without the class check: class items trade like anything else.
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

    -- Every offered copy must still be theirs, and not worn.
    if (select count(*) from public.item_units u
         where u.id = any(v_ids) and u.user_id = p_user_id
           and u.equipped_slot is null)
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

revoke execute on function public.trade_offer_unit_ids(jsonb, uuid) from public, anon, authenticated;

-- As 00146's, without the class check: class items list like anything else.
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

revoke execute on function public.market_list(uuid, uuid, int, int)
  from public, anon, authenticated;
