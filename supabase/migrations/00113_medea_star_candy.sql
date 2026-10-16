-- Medea and Star Candy: the first consumable, and the NPC who sells it.
--
-- Medea is always in Town, like Boboku (00112): no `events` row, no schedule,
-- no stock caps. Her price list is duplicated from MEDEA_STOCK in
-- packages/shared/src/medea.ts, and eat_item's heal list from the catalog's
-- `consumable` fields (medea.test.ts checks both).
--
-- Eating uses up one copy from the bank and heals. On the normal maps the
-- database holds HP, so eat_item heals it here (p_apply_hp). In a boss fight
-- the Town server holds HP: it calls eat_item with p_apply_hp false to use
-- the candy up, heals the fighter itself, and reports the heal through
-- set_herzie_hp's p_heal like a skill's.

INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot)
VALUES
  ('star-candy', 'Star Candy', 'Pink, turquoise, and faintly humming. Eat one to heal 100 HP.',
   'common', 5, NULL, true, false, NULL)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.buy_from_medea(
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
      ('star-candy', 20)
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

-- Eats one copy of a consumable from the bank. With p_apply_hp it also heals
-- the stored HP (capped at max), refusing while knocked out or already full,
-- so a candy is never wasted. Stamped 5 s back like rest_herzie, so eating
-- doesn't hold up regen.
CREATE OR REPLACE FUNCTION public.eat_item(
  p_user_id  uuid,
  p_item_id  text,
  p_apply_hp boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  h       public.herzies%rowtype;
  v_heal  int;
  v_unit  uuid;
  v_eff   real;
  v_max   real;
BEGIN
  SELECT * INTO h FROM public.herzies WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-found');
  END IF;

  SELECT c.heal INTO v_heal
    FROM (VALUES
      ('star-candy', 100)
    ) AS c(item_id, heal)
   WHERE c.item_id = p_item_id;
  IF v_heal IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-consumable');
  END IF;

  IF p_apply_hp THEN
    IF h.down THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'down');
    END IF;
    v_max := public.herzie_max_hp(h.level, h.stat_stamina);
    v_eff := public.herzie_effective_hp(
      h.hp, h.hp_at, h.down, h.level, h.stat_stamina, now());
    IF v_eff >= v_max THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'full');
    END IF;
  END IF;

  SELECT id INTO v_unit
    FROM public.item_units
   WHERE user_id = p_user_id
     AND item_id = p_item_id
     AND equipped_slot IS NULL
   LIMIT 1;
  IF v_unit IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'none-left');
  END IF;
  DELETE FROM public.item_units WHERE id = v_unit;

  IF p_apply_hp THEN
    UPDATE public.herzies
       SET hp = least(v_max, v_eff + v_heal),
           hp_at = now() - interval '5 seconds'
     WHERE user_id = p_user_id
    RETURNING * INTO h;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'heal', v_heal,
    'vitals', public.herzie_vitals_json(
      h.hp, h.hp_at, h.down, h.level, h.stat_stamina),
    'state', public.item_state(p_user_id));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.buy_from_medea(uuid, text, int)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.eat_item(uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
