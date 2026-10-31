-- The market board: AFK selling between players.
--
-- Trades (00002, 00079) need both players online at once. The board doesn't:
-- a player lists one copy at a fixed price and goes away, and anyone can buy
-- it from Plutus in Town while they're offline. The coins, less the market's
-- cut, wait at the board until the seller comes back and collects them, and
-- so does a copy that didn't sell (cancelled, or past its 48 hours). That's
-- why there's no inbox: the board itself is where "it sold" is found out.
--
-- Escrow is by removal. Listing deletes the item_units row and keeps what the
-- copy was (item, upgrade level, when it was first acquired) on the listing.
-- With no row, equip_unit, sell_units, execute_trade and apply_item_upgrade
-- can't touch a listed copy, so none of them needed changing. Buying or
-- collecting inserts a fresh row.
--
-- Expiry is derived, not swept: an 'active' listing past expires_at is treated
-- as expired by every reader and RPC (the lesson of 00057/00059), and
-- market_collect persists the flip when it hands the copy back.
--
-- The rules are duplicated from packages/shared/src/market.ts as the c_*
-- constants below (market.test.ts checks they agree). Bank capacity is the
-- routes' pre-check, as everywhere else (it lives in shared TS).

create table public.market_listings (
  id            uuid primary key default gen_random_uuid(),
  seller_id     uuid not null references public.herzies(user_id) on delete cascade,
  item_id       text not null,
  upgrade_level int not null default 0 check (upgrade_level between 0 and 3),
  acquired_at   timestamptz not null,
  price         int not null check (price > 0),
  -- The market's cut, fixed when listed so a later rule change can't alter a
  -- sale already agreed.
  fee           int not null check (fee >= 0 and fee < price),
  status        text not null default 'active'
                check (status in ('active', 'sold', 'cancelled', 'expired')),
  -- No FK: a buyer who deletes their herzie shouldn't take the seller's sale
  -- with them.
  buyer_id      uuid,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  sold_at       timestamptz,
  -- When the seller took the coins or the copy back. Null on a finished
  -- listing = waiting at the board.
  collected_at  timestamptz
);

create index market_listings_browse_idx
  on public.market_listings (item_id, price)
  where status = 'active';
create index market_listings_seller_idx
  on public.market_listings (seller_id, status)
  where collected_at is null;

-- RLS on, no policies: only the service role and the RPCs below read it.
alter table public.market_listings enable row level security;

-- A listing as the routes return it (MarketListing in market.ts), with an
-- 'active' listing past its time reported as expired.
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
    'price', l.price,
    'fee', l.fee,
    'status', case when l.status = 'active' and l.expires_at <= now()
                   then 'expired' else l.status end,
    'createdAt', l.created_at,
    'expiresAt', l.expires_at,
    'soldAt', l.sold_at
  );
$$;

create or replace function public.market_list(
  p_user_id uuid,
  p_unit_id uuid,
  p_price   int
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
  v_unit    public.item_units;
  v_item    public.items;
  v_active  int;
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

  -- Anything at or below what the game pays is better sold to the game.
  if p_price is null or p_price <= coalesce(v_item.sell_price, 0) then
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

  delete from public.item_units where id = v_unit.id;

  insert into public.market_listings
    (seller_id, item_id, upgrade_level, acquired_at, price, fee, expires_at)
  values
    (p_user_id, v_unit.item_id, v_unit.upgrade_level, v_unit.acquired_at,
     p_price, greatest(1, (p_price * c_fee_percent) / 100),
     now() + make_interval(hours => c_listing_hours))
  returning * into v_listing;

  return jsonb_build_object(
    'ok', true,
    'listing', public.market_listing_json(v_listing),
    'state', public.item_state(p_user_id));
end;
$$;

create or replace function public.market_cancel(
  p_user_id    uuid,
  p_listing_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_listing public.market_listings;
begin
  select * into v_listing from public.market_listings
   where id = p_listing_id and seller_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-owned');
  end if;
  if v_listing.status <> 'active' or v_listing.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'gone');
  end if;

  update public.market_listings set status = 'cancelled'
   where id = v_listing.id
  returning * into v_listing;

  return jsonb_build_object(
    'ok', true, 'listing', public.market_listing_json(v_listing));
end;
$$;

-- The listing is locked first, so of two buyers racing for it the second
-- waits, then finds it sold.
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
  values (p_user_id, v_listing.item_id, v_listing.upgrade_level, now());

  return jsonb_build_object(
    'ok', true,
    'spent', v_listing.price,
    'newCurrency', v_currency,
    'listing', public.market_listing_json(v_listing),
    'state', public.item_state(p_user_id));
end;
$$;

-- Everything waiting at the board: coins from sales, and (when p_take_items)
-- the copies of cancelled or expired listings. The route passes false when
-- the bank has no room, so the coins still come and the copies keep waiting.
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
      returning item_id, upgrade_level, acquired_at
    ), inserted as (
      insert into public.item_units (user_id, item_id, upgrade_level, acquired_at)
      select p_user_id, item_id, upgrade_level, acquired_at from returned
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
revoke execute on function public.market_list(uuid, uuid, int)
  from public, anon, authenticated;
revoke execute on function public.market_cancel(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.market_buy(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.market_collect(uuid, boolean)
  from public, anon, authenticated;
