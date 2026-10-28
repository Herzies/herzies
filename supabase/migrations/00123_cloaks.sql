-- Cloaks: a new 'back' slot, mirroring packages/shared/src/items.ts.
--
-- Four cloaks, all stage 3 (equip_unit already checks items.min_stage, and
-- a slot other than 'ground' is used as-is, as with 'spirit' in 00099 and
-- the hand slots in 00106, so it needs no change):
--   - three legendary class cloaks, suited to a class but wearable by any
--     herzie, that come only from a boss's random loot (boss_loot_roll
--     below; never a listening drop: NON_DROPPABLE_ITEM_IDS in the catalog);
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

-- 00118's boss_loot_roll, plus the class cloaks at the legendary weight
-- (3, boosted ×2). The weights are duplicated from bossLootWeights() in
-- packages/shared/src/items.ts (items.test.ts checks they agree).
CREATE OR REPLACE FUNCTION public.boss_loot_roll()
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  SELECT p.item_id
    FROM (VALUES
      ('power-dice-1', 50),
      ('power-dice-2', 16),
      ('power-dice-3', 6),
      ('safety-pick', 16),
      ('headphones', 225),
      ('rainbow-headband', 225),
      ('gold-chain', 50),
      ('pearl-necklace', 225),
      ('bowtie', 225),
      ('boombox', 50),
      ('good-eye-sniper', 50),
      ('clouds', 50),
      ('stars', 50),
      ('prism', 225),
      ('poseidons-gift', 225),
      ('purple-dane', 225),
      ('thanks-for-all-the-fish', 225),
      ('troubadour-mantle', 6),
      ('groove-cape', 6),
      ('drumhide-cloak', 6)
    ) AS p(item_id, weight)
   ORDER BY -ln(1 - random()) / p.weight
   LIMIT 1;
$$;

revoke execute on function public.boss_loot_roll() from public, anon, authenticated;
