-- Cloaks: a new 'back' slot, mirroring packages/shared/src/items.ts.
--
-- Four cloaks, all stage 3 (equip_unit already checks items.min_stage, and
-- a slot other than 'ground' is used as-is, as with 'spirit' in 00099 and
-- the hand slots in 00106, so it needs no change):
--   - three legendary class cloaks, suited to a class but wearable by any
--     herzie, that come only from a boss fight's reward pools (00124,
--     set per fight in the admin; never a listening drop nor a random
--     roll: NON_DROPPABLE_ITEM_IDS in the catalog);
--   - the Tailwind Cloak (+8% move speed), sold for money only as a Stripe
--     product whose metadata.item_id is 'tailwind-cloak'. It's never
--     dropped, and the upgrade route refuses it a die (noUpgrade), so a
--     failed risky roll can't destroy something bought.
-- Stats live only in the TS catalog, as ever.

alter table public.items drop constraint items_equip_slot_check;
alter table public.items add constraint items_equip_slot_check
  check (equip_slot is null or equip_slot in (
    'head', 'face', 'body', 'scenery', 'ground', 'spirit', 'color', 'modifier',
    'main_hand', 'off_hand', 'back'
  ));

alter table public.item_units drop constraint item_units_equipped_slot_check;
alter table public.item_units add constraint item_units_equipped_slot_check
  check (equipped_slot is null or equipped_slot in (
    'head', 'face', 'body', 'scenery', 'ground_left', 'ground_right',
    'spirit', 'color', 'modifier', 'main_hand', 'off_hand', 'back'
  ));

INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot, min_stage, required_class)
VALUES
  ('troubadour-mantle', 'Troubadour''s Mantle', 'Velvet for the long road. Billows on the high notes.',
   'legendary', 500, NULL, false, true, 'back', 3, NULL),
  ('groove-cape', 'Groove Cape', 'Pressed from a master copy. Every fold a B-side.',
   'legendary', 500, NULL, false, true, 'back', 3, NULL),
  ('drumhide-cloak', 'Drumhide Cloak', 'Cut from a kick drum that never gave in.',
   'legendary', 500, NULL, false, true, 'back', 3, NULL),
  ('tailwind-cloak', 'Tailwind Cloak', 'Silk that would rather be somewhere else. Takes you with it.',
   'legendary', 500, NULL, false, true, 'back', 3, NULL)
ON CONFLICT (id) DO NOTHING;
