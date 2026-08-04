-- Convert herzies.equipped from item-ID array to slot-keyed object, and
-- seed the coffee-mug ground prop. Ground items in existing arrays land on
-- ground_left so nothing disappears mid-migration.

-- Catalog: coffee mug (ground category — side chosen at equip time).
INSERT INTO public.items (id, name, description, rarity, sell_price, stackable, equipable, equip_slot)
VALUES
  (
    'coffee-mug',
    'Coffee Mug',
    'A warm mug for getting back to work. Sits by your herzie''s feet.',
    'uncommon',
    null,
    false,
    true,
    'ground'
  )
ON CONFLICT (id) DO NOTHING;

-- Rewrite equipped arrays → slot maps.
DO $$
DECLARE
  r RECORD;
  item_id text;
  slot text;
  new_map jsonb;
  arr jsonb;
BEGIN
  FOR r IN
    SELECT user_id, equipped
    FROM public.herzies
    WHERE jsonb_typeof(equipped) = 'array'
  LOOP
    new_map := '{}'::jsonb;
    arr := r.equipped;

    FOR item_id IN
      SELECT jsonb_array_elements_text(arr)
    LOOP
      SELECT equip_slot INTO slot
      FROM public.items
      WHERE id = item_id;

      IF slot IS NULL THEN
        CONTINUE;
      ELSIF slot = 'ground' THEN
        -- Prefer left; only use right if left already filled.
        IF new_map ? 'ground_left' THEN
          new_map := new_map || jsonb_build_object('ground_right', item_id);
        ELSE
          new_map := new_map || jsonb_build_object('ground_left', item_id);
        END IF;
      ELSE
        new_map := new_map || jsonb_build_object(slot, item_id);
      END IF;
    END LOOP;

    UPDATE public.herzies
    SET equipped = new_map
    WHERE user_id = r.user_id;
  END LOOP;

  -- Any remaining non-object defaults (shouldn't happen) become {}.
  UPDATE public.herzies
  SET equipped = '{}'::jsonb
  WHERE jsonb_typeof(equipped) <> 'object';
END $$;

ALTER TABLE public.herzies
  ALTER COLUMN equipped SET DEFAULT '{}'::jsonb;
