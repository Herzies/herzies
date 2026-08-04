-- Remove the coffee-mug item from catalog, inventories, and equipped slots.

-- Unequip from ground slots.
UPDATE public.herzies
SET equipped = equipped - 'ground_left'
WHERE equipped->>'ground_left' = 'coffee-mug';

UPDATE public.herzies
SET equipped = equipped - 'ground_right'
WHERE equipped->>'ground_right' = 'coffee-mug';

-- Strip from inventories.
UPDATE public.herzies
SET inventory_v2 = inventory_v2 - 'coffee-mug'
WHERE inventory_v2 ? 'coffee-mug';

-- Drop from catalog.
DELETE FROM public.items
WHERE id = 'coffee-mug';
