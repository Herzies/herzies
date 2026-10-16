-- Boboku: always in Town, selling the basic class instruments for coins.
--
-- Unlike George he isn't an event: no `events` row, no schedule, no stock
-- caps or per-player limits. Anyone can buy any instrument; equip_unit still
-- holds each to its class (required_class) and stage. Now that instruments
-- carry stats and break on a failed risky dice roll, he's where a broken one
-- is replaced.
--
-- The price list is duplicated from BOBOKU_STOCK in
-- packages/shared/src/boboku.ts (boboku.test.ts checks they agree).

CREATE OR REPLACE FUNCTION public.buy_from_boboku(
  p_user_id  uuid,
  p_item_id  text,
  p_quantity int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_price    int;
  v_cost     int;
  v_currency int;
BEGIN
  PERFORM 1 FROM public.herzies WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-found');
  END IF;

  IF p_quantity IS NULL OR p_quantity < 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad-quantity');
  END IF;

  SELECT s.price INTO v_price
    FROM (VALUES
      ('lute', 100),
      ('compact-discs', 100),
      ('worn-stick', 100),
      ('old-cymbal', 100)
    ) AS s(item_id, price)
   WHERE s.item_id = p_item_id;
  IF v_price IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-sold-here');
  END IF;

  v_cost := v_price * p_quantity;

  SELECT currency INTO v_currency FROM public.herzies WHERE user_id = p_user_id;
  IF v_currency < v_cost THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient-funds');
  END IF;

  UPDATE public.herzies
     SET currency = currency - v_cost
   WHERE user_id = p_user_id
  RETURNING currency INTO v_currency;

  INSERT INTO public.item_units (user_id, item_id)
  SELECT p_user_id, p_item_id FROM generate_series(1, p_quantity);

  RETURN jsonb_build_object(
    'ok', true, 'spent', v_cost, 'newCurrency', v_currency,
    'state', public.item_state(p_user_id));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.buy_from_boboku(uuid, text, int)
  FROM PUBLIC, anon, authenticated;
