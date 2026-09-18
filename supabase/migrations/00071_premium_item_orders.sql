-- Let a store order grant an ITEM rather than coins, so premium goods can be
-- sold for real money directly instead of via a coin balance.

-- product_id changes meaning: it used to be a coin-pack id, always resolvable
-- in store_products. It is now "what was bought" — a coin-pack id for legacy
-- orders, a catalog item id for premium ones. Premium items live in Stripe
-- (joined by the product's metadata.item_id), not in store_products, so the
-- foreign key can no longer hold. Legacy rows still resolve, by convention
-- rather than by constraint.
ALTER TABLE public.store_orders
  DROP CONSTRAINT IF EXISTS store_orders_product_id_fkey;

-- Set for an item purchase, NULL for a coin purchase. Which of the two it is
-- is the only thing fulfilment branches on.
ALTER TABLE public.store_orders
  ADD COLUMN IF NOT EXISTS grant_item_id text;

-- Fulfilment, now with a destination for the item branch.
--
-- p_to_ground is decided by the caller rather than computed here: the bank
-- capacity rules (bankSlotsUsed / hasRoomFor in @herzies/shared) are shared
-- with the desktop client and the sync loop, and reimplementing them in SQL
-- would give this one path its own subtly different copy to drift. The
-- webhook works it out with the shared helper and passes the answer in; this
-- function's job is to apply it atomically and exactly once.
CREATE OR REPLACE FUNCTION public.fulfill_store_order(
  p_session_id text,
  p_event_id text,
  p_to_ground boolean
)
RETURNS boolean AS $$
DECLARE
  o public.store_orders;
BEGIN
  SELECT * INTO o FROM public.store_orders
    WHERE stripe_checkout_session_id = p_session_id FOR UPDATE;

  IF NOT FOUND THEN RETURN false; END IF;
  -- Idempotency, covering both branches below: Stripe retries webhooks, and
  -- the test-mode checkout path calls this directly. The row lock above plus
  -- this check is what stops a retry paying out twice.
  IF o.status = 'completed' THEN RETURN true; END IF;

  IF o.grant_item_id IS NOT NULL THEN
    IF p_to_ground THEN
      -- Deliberately a direct INSERT and NOT roll_pending_drops: that function
      -- enforces GROUND_DROP_CAP and returns 0 when the ground is full, which
      -- for a paid item would silently destroy the purchase. A bought item is
      -- never subject to the drop cap. Do not "consolidate" these two.
      INSERT INTO public.pending_drops (user_id, item_id)
      VALUES (o.user_id, o.grant_item_id);
    ELSE
      UPDATE public.herzies
        SET inventory_v2 = jsonb_set(
              inventory_v2,
              ARRAY[o.grant_item_id],
              to_jsonb(COALESCE((inventory_v2->>o.grant_item_id)::int, 0) + 1)
            )
        WHERE user_id = o.user_id;
    END IF;
  ELSE
    UPDATE public.herzies
      SET currency = currency + o.currency_amount
      WHERE user_id = o.user_id;
  END IF;

  UPDATE public.store_orders
    SET status = 'completed', stripe_event_id = p_event_id, completed_at = now()
    WHERE id = o.id;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- The 2-arg form is kept, delegating with p_to_ground => false, purely so the
-- currently deployed webhook keeps working until the web deploy lands.
-- Dropping it instead would 500 every checkout.session.completed in the gap.
CREATE OR REPLACE FUNCTION public.fulfill_store_order(
  p_session_id text,
  p_event_id text
)
RETURNS boolean AS $$
  SELECT public.fulfill_store_order(p_session_id, p_event_id, false);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = '';

-- CREATE OR REPLACE re-grants EXECUTE to PUBLIC, and Supabase additionally
-- grants to anon/authenticated — see 00051, which exists because exactly that
-- was missed here before. This is the function that credits purchases, so a
-- missed revoke lets any authenticated user fulfil their own unpaid order.
-- Both signatures, explicitly.
REVOKE EXECUTE ON FUNCTION public.fulfill_store_order(text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fulfill_store_order(text, text) FROM PUBLIC, anon, authenticated;
