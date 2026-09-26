-- Inventory Expansions: a purchase that raises the buyer's bank capacity.
--
-- Not an item — it is never owned, placed or worn, so it has no item_units row.
-- Buying one just increments a counter. The counter is stored rather than a
-- total slot count so that the starting 18 and the 12-per-expansion live only in
-- @herzies/shared (BANK_SLOT_COUNT, BANK_EXPANSION_SLOTS, bankCapacity); SQL
-- never needs to know either, so there is no second copy to drift.

alter table public.herzies
  add column if not exists bank_expansions integer not null default 0
  check (bank_expansions >= 0);

-- Set for an expansion purchase, NULL otherwise. Fulfilment branches on it the
-- same way it does on grant_item_id.
alter table public.store_orders
  add column if not exists grant_bank_expansions integer
  check (grant_bank_expansions > 0);

-- An order grants at most one kind of thing: coins (both NULL), an item, or an
-- expansion. Both set would be a checkout bug, and fulfilment would silently
-- pick one.
alter table public.store_orders
  drop constraint if exists store_orders_single_grant;
alter table public.store_orders
  add constraint store_orders_single_grant
  check (num_nonnulls(grant_item_id, grant_bank_expansions) <= 1);

-- The herzies UPDATE/INSERT policies constrain rows (auth.uid() = user_id), not
-- columns, so any signed-in player can PATCH their own row through PostgREST.
-- This column is bought with real money and must only ever move through
-- fulfill_store_order, so refuse a write from the client roles. Server code
-- (service_role, and SECURITY DEFINER functions such as fulfill_store_order,
-- which run as their owner) is unaffected.
create or replace function public.herzies_guard_bank_expansions()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and (
       (tg_op = 'INSERT' and new.bank_expansions <> 0)
    or (tg_op = 'UPDATE' and new.bank_expansions is distinct from old.bank_expansions)
  ) then
    raise exception 'bank_expansions can only be changed by a purchase';
  end if;
  return new;
end;
$$;

drop trigger if exists herzies_guard_bank_expansions on public.herzies;
create trigger herzies_guard_bank_expansions
  before insert or update on public.herzies
  for each row execute function public.herzies_guard_bank_expansions();

revoke execute on function public.herzies_guard_bank_expansions() from public, anon, authenticated;

-- Fulfilment, with a third branch. Idempotency, the item branch and its
-- deliberate bypass of GROUND_DROP_CAP are exactly as 00079 left them.
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
  -- Idempotency, covering every branch below: Stripe retries webhooks, and the
  -- test-mode checkout path calls this directly. The row lock above plus this
  -- check is what stops a retry paying out twice.
  if o.status = 'completed' then return true; end if;

  if o.grant_bank_expansions is not null then
    -- Never capped here: the cap (MAX_BANK_EXPANSIONS) is enforced at checkout,
    -- before money moves. By now the money is taken, and refusing to grant would
    -- destroy a paid purchase.
    update public.herzies
      set bank_expansions = bank_expansions + o.grant_bank_expansions
      where user_id = o.user_id;
  elsif o.grant_item_id is not null then
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

-- See 00051: this is the function that credits purchases, so a missed revoke
-- lets any authenticated user fulfil their own unpaid order. Both signatures.
revoke execute on function public.fulfill_store_order(text, text, boolean) from public, anon, authenticated;
revoke execute on function public.fulfill_store_order(text, text) from public, anon, authenticated;
