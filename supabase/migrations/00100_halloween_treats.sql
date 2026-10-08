-- Halloween treats and Nandor the Treatless, mirroring packages/shared/src/items.ts
-- and types.ts.
--
-- Trick or Treat becomes Treat: a common, stackable currency that is no longer
-- worn. During HALLOWEEN_DROP_WINDOW it lands from a roll of its own on every
-- drop tick (SEASONAL_BONUS_DROPS), not from the weighted pool. The id stays
-- 'trick-or-treat' so the icon grids and existing copies keep working.
--
-- Treats are spent at a new visitor, Nandor the Treatless (event type
-- 'treat_trader'), who sells the rest of the Halloween set for them. He reuses
-- George's machinery: the same config shape, merchant_sales /
-- merchant_purchases for stock and limits, and buy_from_merchant, which now
-- takes payment in treats when the event is a treat_trader.
--
-- Ships together with 00099 (Spirit slot), the sync redeploy and a desktop
-- beta, before the Oct 20 window opens.

update public.items
   set name = 'Treat',
       description = 'A sticky handful of sweets. Nandor will want these.',
       rarity = 'common',
       sell_price = 5,
       buy_price = null,
       stackable = true,
       equipable = false,
       equip_slot = null
 where id = 'trick-or-treat';

-- A stackable item never carries per-unit state: take worn copies off and
-- reset any upgrade. Production has one unworn, unupgraded copy.
update public.item_units
   set equipped_slot = null, equipped_at = null, upgrade_level = 0
 where item_id = 'trick-or-treat'
   and (equipped_slot is not null or upgrade_level <> 0);


CREATE OR REPLACE FUNCTION public.buy_from_merchant(
  p_user_id  uuid,
  p_event_id uuid,
  p_item_id  text,
  p_quantity int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_type     text;
  v_entry    jsonb;
  v_price    int;
  v_total    int;
  v_limit    int;
  v_sold     int;
  v_bought   int;
  v_cost     int;
  v_currency int;
  v_spent    int;
BEGIN
  PERFORM 1 FROM public.herzies WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-found');
  END IF;

  IF p_quantity IS NULL OR p_quantity < 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad-quantity');
  END IF;

  SELECT e.type INTO v_type
    FROM public.events e
   WHERE e.id = p_event_id
     AND e.type IN ('merchant', 'treat_trader')
     AND e.active
     AND e.starts_at <= now()
     AND e.ends_at > now();
  IF v_type IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-live');
  END IF;

  SELECT s INTO v_entry
    FROM public.events e,
         jsonb_array_elements(coalesce(e.config -> 'stock', '[]')) s
   WHERE e.id = p_event_id
     AND s ->> 'itemId' = p_item_id
   LIMIT 1;
  IF v_entry IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-sold-here');
  END IF;

  v_price := (v_entry ->> 'price')::int;
  v_total := nullif(v_entry ->> 'totalStock', '')::int;
  v_limit := nullif(v_entry ->> 'perPlayerLimit', '')::int;
  IF v_price IS NULL OR v_price <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-sold-here');
  END IF;

  INSERT INTO public.merchant_sales (event_id, item_id)
  VALUES (p_event_id, p_item_id)
  ON CONFLICT DO NOTHING;

  SELECT sold INTO v_sold
    FROM public.merchant_sales
   WHERE event_id = p_event_id AND item_id = p_item_id
     FOR UPDATE;

  IF v_total IS NOT NULL AND v_sold + p_quantity > v_total THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'sold-out');
  END IF;

  SELECT coalesce(max(quantity), 0) INTO v_bought
    FROM public.merchant_purchases
   WHERE event_id = p_event_id AND user_id = p_user_id AND item_id = p_item_id;

  IF v_limit IS NOT NULL AND v_bought + p_quantity > v_limit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'limit-reached');
  END IF;

  v_cost := v_price * p_quantity;

  IF v_type = 'treat_trader' THEN
    -- Paid in treats, unworn copies only. The herzie row lock above
    -- serializes this against any other spend of the same copies.
    SELECT count(*) INTO v_spent
      FROM public.item_units
     WHERE user_id = p_user_id
       AND item_id = 'trick-or-treat'
       AND equipped_slot IS NULL;
    IF v_spent < v_cost THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient-treats');
    END IF;

    DELETE FROM public.item_units
     WHERE id IN (
       SELECT id FROM public.item_units
        WHERE user_id = p_user_id
          AND item_id = 'trick-or-treat'
          AND equipped_slot IS NULL
        LIMIT v_cost
          FOR UPDATE
     );
    -- Belt and braces: every other path that removes units takes the herzie
    -- lock too, but a short delete must never sell at a discount.
    GET DIAGNOSTICS v_spent = ROW_COUNT;
    IF v_spent < v_cost THEN
      RAISE EXCEPTION 'treat spend removed % of % treats', v_spent, v_cost;
    END IF;
  ELSE
    SELECT currency INTO v_currency FROM public.herzies WHERE user_id = p_user_id;
    IF v_currency < v_cost THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient-funds');
    END IF;

    UPDATE public.herzies
       SET currency = currency - v_cost
     WHERE user_id = p_user_id
    RETURNING currency INTO v_currency;
  END IF;

  INSERT INTO public.item_units (user_id, item_id)
  SELECT p_user_id, p_item_id FROM generate_series(1, p_quantity);

  UPDATE public.merchant_sales
     SET sold = sold + p_quantity
   WHERE event_id = p_event_id AND item_id = p_item_id;

  INSERT INTO public.merchant_purchases (event_id, user_id, item_id, quantity)
  VALUES (p_event_id, p_user_id, p_item_id, p_quantity)
  ON CONFLICT (event_id, user_id, item_id)
  DO UPDATE SET quantity = public.merchant_purchases.quantity + excluded.quantity;

  -- newCurrency is null for a treat_trader: coins were not touched.
  RETURN jsonb_build_object(
    'ok', true, 'spent', v_cost, 'newCurrency', v_currency,
    'state', public.item_state(p_user_id));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.buy_from_merchant(uuid, uuid, text, int)
  FROM PUBLIC, anon, authenticated;
