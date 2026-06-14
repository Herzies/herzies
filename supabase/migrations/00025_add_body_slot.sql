-- Introduce the 'body' equip slot (torso-worn accessories) alongside the
-- existing slots. No catalog items are added here.

ALTER TABLE public.items
DROP CONSTRAINT IF EXISTS items_equip_slot_check;

ALTER TABLE public.items
ADD CONSTRAINT items_equip_slot_check
CHECK (
  equip_slot IS NULL
  OR equip_slot IN ('head', 'face', 'body', 'scenery', 'ground')
);
