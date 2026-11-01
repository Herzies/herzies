-- Emotes: premium animations, unlocked for good on the herzie (like the
-- Bigger Bag, not an item: never owned as a unit, placed or traded).
--
-- The ids live in @herzies/shared (EMOTES); SQL only stores which are owned.
-- They are sold as Stripe products whose metadata.emote_id names one, and
-- granted here by fulfill_store_order. The town-ticket edge function signs
-- the list into the Town ticket, so the town-server can refuse an emote you
-- don't own.

alter table public.herzies
  add column if not exists emotes text[] not null default '{}';

-- Set for an emote purchase, NULL otherwise.
alter table public.store_orders
  add column if not exists grant_emote_id text;

-- An order grants at most one kind of thing: coins (all NULL), an item, an
-- expansion or an emote.
alter table public.store_orders
  drop constraint if exists store_orders_single_grant;
alter table public.store_orders
  add constraint store_orders_single_grant
  check (num_nonnulls(grant_item_id, grant_bank_expansions, grant_emote_id) <= 1);

-- Bought with real money, so only a purchase moves it. Clients have no write
-- grant on herzies today (00097); this keeps it so if one ever comes back.
-- Same guard as bank_expansions (00080).
create or replace function public.herzies_guard_emotes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and (
       (tg_op = 'INSERT' and cardinality(new.emotes) <> 0)
    or (tg_op = 'UPDATE' and new.emotes is distinct from old.emotes)
  ) then
    raise exception 'emotes can only be changed by a purchase';
  end if;
  return new;
end;
$$;

drop trigger if exists herzies_guard_emotes on public.herzies;
create trigger herzies_guard_emotes
  before insert or update on public.herzies
  for each row execute function public.herzies_guard_emotes();

revoke execute on function public.herzies_guard_emotes() from public, anon, authenticated;

-- As 00080, with an emote branch. Owning one already is refused at checkout;
-- if two checkouts raced, the second is still marked completed and grants
-- nothing new (the money is taken by then, so it is not refused here).
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

  if o.grant_emote_id is not null then
    update public.herzies
      set emotes = array_append(emotes, o.grant_emote_id)
      where user_id = o.user_id
        and not (o.grant_emote_id = any(emotes));
  elsif o.grant_bank_expansions is not null then
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
