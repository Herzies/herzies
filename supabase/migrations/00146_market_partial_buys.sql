-- Buying part of a stack on the market board. A listing whose price splits
-- evenly across its copies can be bought a few copies at a time, at that
-- price each; one that doesn't split (a lot priced as a whole before this)
-- still sells all at once. The desktop now prices stacks per copy, so new
-- stacks always split.
--
-- A partial buy splits the row: the listing keeps the copies left (its
-- price and fee shrink), and a new 'sold' row holds what was bought, so
-- market_collect pays the seller per sale as before.
--
-- Also: a copy now lists at 2 coins at least. A price of 1 has a 1-coin fee,
-- which the fee < price check refuses.
--
-- The rules are duplicated from packages/shared/src/market.ts as the c_*
-- constants below (market.test.ts checks they agree).

-- As 00129, with the per-copy minimum.
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

drop function public.market_buy(uuid, uuid);

-- As 00129, buying `p_quantity` copies (all of them when null). `listing` in
-- the reply is the listing as it now stands: sold, or still up with fewer
-- copies after a partial buy.
create or replace function public.market_buy(
  p_user_id    uuid,
  p_listing_id uuid,
  p_quantity   int default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_fee_percent constant int := 5;
  v_listing  public.market_listings;
  v_currency int;
  v_count    int;
  v_cost     int;
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

  v_count := coalesce(p_quantity, v_listing.quantity);
  if v_count < 1 or v_count > v_listing.quantity then
    return jsonb_build_object('ok', false, 'reason', 'not-that-many');
  end if;
  -- Only a price that splits evenly, at 2 coins a copy or more (so each part
  -- passes the fee < price check), can be bought a part at a time. Kept in
  -- step with marketPriceEach in market.ts.
  if v_count < v_listing.quantity
     and (v_listing.price % v_listing.quantity <> 0
          or v_listing.price / v_listing.quantity < 2) then
    return jsonb_build_object('ok', false, 'reason', 'whole-lot');
  end if;
  v_cost := v_listing.price / v_listing.quantity * v_count;
  if v_count = v_listing.quantity then
    v_cost := v_listing.price;
  end if;

  select currency into v_currency from public.herzies
   where user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;
  if v_currency < v_cost then
    return jsonb_build_object('ok', false, 'reason', 'insufficient-funds');
  end if;

  update public.herzies
     set currency = currency - v_cost
   where user_id = p_user_id
  returning currency into v_currency;

  if v_count = v_listing.quantity then
    update public.market_listings
       set status = 'sold', buyer_id = p_user_id, sold_at = now()
     where id = v_listing.id
    returning * into v_listing;
  else
    -- What was bought becomes its own sold row, for the seller to collect.
    insert into public.market_listings
      (seller_id, item_id, upgrade_level, acquired_at, quantity, price, fee,
       status, buyer_id, created_at, expires_at, sold_at)
    values
      (v_listing.seller_id, v_listing.item_id, v_listing.upgrade_level,
       v_listing.acquired_at, v_count, v_cost,
       greatest(1, (v_cost * c_fee_percent) / 100),
       'sold', p_user_id, v_listing.created_at, v_listing.expires_at, now());

    update public.market_listings
       set quantity = quantity - v_count,
           price = price - v_cost,
           fee = greatest(1, ((price - v_cost) * c_fee_percent) / 100)
     where id = v_listing.id
    returning * into v_listing;
  end if;

  insert into public.item_units (user_id, item_id, upgrade_level, acquired_at)
  select p_user_id, v_listing.item_id, v_listing.upgrade_level, now()
    from generate_series(1, v_count);

  return jsonb_build_object(
    'ok', true,
    'spent', v_cost,
    'quantity', v_count,
    'newCurrency', v_currency,
    'listing', public.market_listing_json(v_listing),
    'state', public.item_state(p_user_id));
end;
$$;

revoke execute on function public.market_list(uuid, uuid, int, int)
  from public, anon, authenticated;
revoke execute on function public.market_buy(uuid, uuid, int)
  from public, anon, authenticated;
