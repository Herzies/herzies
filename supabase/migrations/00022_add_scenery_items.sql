-- Scenery items: equippable sky backgrounds sharing a mutually-exclusive slot.

-- Allow the new 'scenery' equip slot alongside 'head'.
ALTER TABLE public.items
DROP CONSTRAINT IF EXISTS items_equip_slot_check;

ALTER TABLE public.items
ADD CONSTRAINT items_equip_slot_check
CHECK (equip_slot IS NULL OR equip_slot IN ('head', 'scenery'));

-- Catalog entries only; not granted to any user's inventory.
INSERT INTO public.items (id, name, description, rarity, sell_price, stackable, equipable, equip_slot)
VALUES
  (
    'clouds',
    'Clouds',
    'Drifting clouds for your herzie''s sky.',
    'uncommon',
    null,
    false,
    true,
    'scenery'
  ),
  (
    'stars',
    'Stars',
    'A twinkling starfield for your herzie''s sky.',
    'uncommon',
    null,
    false,
    true,
    'scenery'
  )
ON CONFLICT (id) DO NOTHING;
