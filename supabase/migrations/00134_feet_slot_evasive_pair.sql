-- A 'feet' slot and its first item, Eivind's Evasive Pair: mythic shoes,
-- +20% move speed (stats live only in the TS catalog, as ever). Drop-only:
-- it joins the listening pool (read from this table, less
-- NON_DROPPABLE_ITEM_IDS) and a boss's random loot, and no shop stocks it.
--
-- equip_unit uses any slot but 'ground' as-is (00106), so it needs no change.
-- The catalog row mirrors packages/shared/src/items.ts, and boss_loot_roll's
-- weights mirror bossLootWeights() there (items.test.ts checks they agree):
-- mythic's drop weight 1, times the boss's mythic boost 2.
--
-- Apply with or after the desktop release that knows the slot, so older
-- clients never receive an item in a slot they don't know.

alter table public.items drop constraint items_equip_slot_check;
alter table public.items add constraint items_equip_slot_check
  check (equip_slot is null or equip_slot in (
    'head', 'face', 'body', 'scenery', 'ground', 'spirit', 'color', 'modifier',
    'main_hand', 'off_hand', 'back', 'feet'
  ));

alter table public.item_units drop constraint item_units_equipped_slot_check;
alter table public.item_units add constraint item_units_equipped_slot_check
  check (equipped_slot is null or equipped_slot in (
    'head', 'face', 'body', 'scenery', 'ground_left', 'ground_right',
    'spirit', 'color', 'modifier', 'main_hand', 'off_hand', 'back', 'feet'
  ));

INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot)
VALUES
  ('eivinds-evasive-pair', 'Eivind''s Evasive Pair',
   'A pair of incredibly evasive shoes. Careful, or you''ll end up in a different dimension',
   'mythic', 1500, NULL, false, true, 'feet')
ON CONFLICT (id) DO NOTHING;

-- As 00131, with the shoes in the pool.
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
      ('plutus-crown', 225),
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
      ('fabulous-fabian', 50),
      ('fyllings-fedora', 50),
      ('eivinds-evasive-pair', 2)
    ) AS p(item_id, weight)
   ORDER BY -ln(1 - random()) / p.weight
   LIMIT 1;
$$;

revoke execute on function public.boss_loot_roll() from public, anon, authenticated;
