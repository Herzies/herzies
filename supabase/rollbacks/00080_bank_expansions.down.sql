-- ROLLBACK for 00080_bank_expansions.sql (not a migration: apply by hand, only if 00080 must be undone).
--
-- Restores 00079's fulfill_store_order and drops the expansion columns. Any
-- expansions already bought are LOST with the column — refund those orders
-- (store_orders.grant_bank_expansions is not null) before running this.
--
-- Redeploy the previous web build and edge functions too: they select
-- herzies.bank_expansions, which this removes.

begin;

drop trigger if exists herzies_guard_bank_expansions on public.herzies;
drop function if exists public.herzies_guard_bank_expansions();

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
  if o.status = 'completed' then return true; end if;

  if o.grant_item_id is not null then
    if p_to_ground then
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

revoke execute on function public.fulfill_store_order(text, text, boolean) from public, anon, authenticated;
revoke execute on function public.fulfill_store_order(text, text) from public, anon, authenticated;

alter table public.store_orders drop constraint if exists store_orders_single_grant;
alter table public.store_orders drop column if exists grant_bank_expansions;
alter table public.herzies drop column if exists bank_expansions;

commit;
