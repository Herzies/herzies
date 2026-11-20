-- The class set pieces (00150) drop at random after all: the hats, neck
-- pieces and shoes join the listening/Crystal pool (read from the items
-- table, less NON_DROPPABLE_ITEM_IDS, which no longer lists them) at the
-- legendary weight, and a boss's random loot at that times the boss's
-- legendary boost of 2. The class cloaks stay boss-only (BOSS_ONLY_ITEM_IDS):
-- only a fight's reward pools give them.
--
-- boss_loot_roll's weights mirror bossLootWeights() in
-- packages/shared/src/items.ts (items.test.ts checks they agree). Apply with
-- or after 00150.

-- As 00149, with the nine set pieces in the pool.
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
      ('fyllings-necktie', 50),
      ('fyllings-loafers', 50),
      ('fyllings-cape', 50),
      ('fyllings-monocle', 50),
      ('fyllings-black', 50),
      ('eivinds-evasive-pair', 2),
      ('eivinds-wings', 2),
      ('ff-sneakers-black', 50),
      ('ff-cloak-black', 50),
      ('ff-pearls-marble', 50),
      ('ff-shades', 50),
      ('ff-pink', 50),
      ('troubadour-plume', 6),
      ('troubadour-ruff', 6),
      ('troubadour-slippers', 6),
      ('groove-cap', 6),
      ('spindle-chain', 6),
      ('groove-kicks', 6),
      ('drumhide-helm', 6),
      ('drumhide-gorget', 6),
      ('drumhide-boots', 6)
    ) AS p(item_id, weight)
   ORDER BY -ln(1 - random()) / p.weight
   LIMIT 1;
$$;

revoke execute on function public.boss_loot_roll() from public, anon, authenticated;
