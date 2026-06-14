-- Ground slot: props that sit on the ground beside the herzie. First item: Boombox.

-- Allow the new 'ground' equip slot alongside 'head', 'face' and 'scenery'.
ALTER TABLE public.items
DROP CONSTRAINT IF EXISTS items_equip_slot_check;

ALTER TABLE public.items
ADD CONSTRAINT items_equip_slot_check
CHECK (equip_slot IS NULL OR equip_slot IN ('head', 'face', 'scenery', 'ground'));

-- Catalog entry only; granted to users via rewards / hunts.
INSERT INTO public.items (id, name, description, rarity, sell_price, stackable, equipable, equip_slot)
VALUES
  (
    'boombox',
    'Boombox',
    'A retro boombox that sits by your herzie''s feet.',
    'rare',
    null,
    false,
    true,
    'ground'
  )
ON CONFLICT (id) DO NOTHING;
