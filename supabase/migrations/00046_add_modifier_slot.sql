-- Give modifier items (gameplay-effect equipables like Good Eye Sniper) their
-- own dedicated 'modifier' equip slot instead of sharing the 'ground' slot
-- with cosmetic props. Unlike every other slot, any number of modifier items
-- can be equipped at once — herzies.equipped stores them as a jsonb array
-- under the "modifier" key rather than a single-value slot key.

ALTER TABLE public.items
DROP CONSTRAINT IF EXISTS items_equip_slot_check;

ALTER TABLE public.items
ADD CONSTRAINT items_equip_slot_check
CHECK (
  equip_slot IS NULL
  OR equip_slot IN ('head', 'face', 'body', 'scenery', 'ground', 'color', 'modifier')
);

UPDATE public.items
SET equip_slot = 'modifier'
WHERE id = 'good-eye-sniper';

-- Move any live equip out of ground_left/ground_right into the new
-- modifier array so nobody silently loses their XP boost.
UPDATE public.herzies
SET equipped = (equipped - 'ground_left' - 'ground_right')
    || jsonb_build_object('modifier', jsonb_build_array('good-eye-sniper'))
WHERE equipped->>'ground_left' = 'good-eye-sniper'
   OR equipped->>'ground_right' = 'good-eye-sniper';
