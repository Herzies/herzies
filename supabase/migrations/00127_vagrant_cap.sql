-- The Vagrant Cap: Boboku's tweed flat cap (the 'sixpence' the renderer has
-- drawn on him since 00112), now an item herzies can wear. He sells a spare
-- for 300 coins; it never drops (NON_DROPPABLE_ITEM_IDS), so the drop pool
-- and boss_loot_roll are unchanged.
--
-- The catalog row mirrors the new entry in packages/shared/src/items.ts, and
-- buy_from_boboku's price list mirrors BOBOKU_STOCK in
-- packages/shared/src/boboku.ts (boboku.test.ts checks they agree).

INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot)
VALUES
  ('sixpence', 'Vagrant Cap', 'Boboku''s spare tweed flat cap. A little worn, a lot of character.', 'uncommon', 100, NULL, false, true, 'head')
ON CONFLICT (id) DO NOTHING;

-- As 00112, with the cap on the list.
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
      ('old-cymbal', 100),
      ('sixpence', 300)
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
