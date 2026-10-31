-- Stacks on the market board: a listing can hold several copies of a
-- stackable item (Star Candy, Treats…), sold together at one price for the
-- lot. Something that doesn't stack is still listed one copy at a time.
--
-- The copies are escrowed as before (00126): their item_units rows are
-- deleted when listed, and `quantity` fresh rows are inserted for the buyer,
-- or for the seller when the stack comes back unsold.
--
-- The rules are duplicated from packages/shared/src/market.ts as the c_*
-- constants below (market.test.ts checks they agree).

alter table public.market_listings
  add column quantity int not null default 1
  check (quantity between 1 and 999);

create or replace function public.market_listing_json(l public.market_listings)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', l.id,
    'sellerId', l.seller_id,
    'itemId', l.item_id,
    'upgradeLevel', l.upgrade_level,
    'quantity', l.quantity,
    'price', l.price,
    'fee', l.fee,
    'status', case when l.status = 'active' and l.expires_at <= now()
                   then 'expired' else l.status end,
    'createdAt', l.created_at,
    'expiresAt', l.expires_at,
    'soldAt', l.sold_at
  );
$$;

drop function public.market_list(uuid, uuid, int);

-- As 00126, taking `p_quantity` copies like `p_unit_id` (same item, same
-- level, none worn), oldest first after the one picked. The price is for the
-- whole stack, and has to beat what the game pays for all of it.
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
  -- Class gear is bound to its herzie (00106), same as for trades.
  if not found or v_item.required_class is not null then
    return jsonb_build_object('ok', false, 'reason', 'bound');
  end if;

  if p_quantity is null or p_quantity < 1 or p_quantity > c_max_stack then
    return jsonb_build_object('ok', false, 'reason', 'bad-quantity');
  end if;
  if p_quantity > 1 and not v_item.stackable then
    return jsonb_build_object('ok', false, 'reason', 'not-stackable');
  end if;

  -- Anything at or below what the game pays is better sold to the game.
  if p_price is null
     or p_price <= coalesce(v_item.sell_price, 0) * p_quantity then
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

-- As 00126, handing over every copy in the stack.
create or replace function public.market_buy(
  p_user_id    uuid,
  p_listing_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_listing  public.market_listings;
  v_currency int;
begin
  select * into v_listing from public.market_listings
   where id = p_listing_id
   for update;
  if not found or v_listing.status <> 'active'
     or v_listing.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'gone');
  end if;
  if v_listing.seller_id = p_user_id then
    return jsonb_build_object('ok', false, 'reason', 'own-listing');
  end if;

  select currency into v_currency from public.herzies
   where user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;
  if v_currency < v_listing.price then
    return jsonb_build_object('ok', false, 'reason', 'insufficient-funds');
  end if;

  update public.herzies
     set currency = currency - v_listing.price
   where user_id = p_user_id
  returning currency into v_currency;

  update public.market_listings
     set status = 'sold', buyer_id = p_user_id, sold_at = now()
   where id = v_listing.id
  returning * into v_listing;

  insert into public.item_units (user_id, item_id, upgrade_level, acquired_at)
  select p_user_id, v_listing.item_id, v_listing.upgrade_level, now()
    from generate_series(1, v_listing.quantity);

  return jsonb_build_object(
    'ok', true,
    'spent', v_listing.price,
    'newCurrency', v_currency,
    'listing', public.market_listing_json(v_listing),
    'state', public.item_state(p_user_id));
end;
$$;

-- As 00126, giving back every copy of an unsold stack; `items` counts copies.
create or replace function public.market_collect(
  p_user_id    uuid,
  p_take_items boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_coins    int;
  v_items    int := 0;
  v_currency int;
begin
  perform 1 from public.herzies where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  update public.market_listings
     set status = 'expired'
   where seller_id = p_user_id and status = 'active' and expires_at <= now();

  with paid as (
    update public.market_listings
       set collected_at = now()
     where seller_id = p_user_id and status = 'sold' and collected_at is null
    returning price - fee as payout
  )
  select coalesce(sum(payout), 0) into v_coins from paid;

  if p_take_items then
    with returned as (
      update public.market_listings
         set collected_at = now()
       where seller_id = p_user_id
         and status in ('cancelled', 'expired')
         and collected_at is null
      returning item_id, upgrade_level, acquired_at, quantity
    ), inserted as (
      insert into public.item_units (user_id, item_id, upgrade_level, acquired_at)
      select p_user_id, r.item_id, r.upgrade_level, r.acquired_at
        from returned r, generate_series(1, r.quantity)
      returning 1
    )
    select count(*) into v_items from inserted;
  end if;

  update public.herzies
     set currency = currency + v_coins
   where user_id = p_user_id
  returning currency into v_currency;

  return jsonb_build_object(
    'ok', true,
    'coins', v_coins,
    'items', v_items,
    'newCurrency', v_currency,
    'state', public.item_state(p_user_id));
end;
$$;

revoke execute on function public.market_listing_json(public.market_listings)
  from public, anon, authenticated;
revoke execute on function public.market_list(uuid, uuid, int, int)
  from public, anon, authenticated;
revoke execute on function public.market_buy(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.market_collect(uuid, boolean)
  from public, anon, authenticated;
