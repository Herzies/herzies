-- Slot category for equipable items (one equipped per slot).
ALTER TABLE public.items
ADD COLUMN IF NOT EXISTS equip_slot text;

ALTER TABLE public.items
DROP CONSTRAINT IF EXISTS items_equip_slot_check;

ALTER TABLE public.items
ADD CONSTRAINT items_equip_slot_check
CHECK (equip_slot IS NULL OR equip_slot IN ('head'));

UPDATE public.items
SET equip_slot = 'head'
WHERE id IN ('headphones', 'rainbow-headband');
