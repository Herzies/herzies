-- The class cloaks (00123) join a boss's random loot.
--
-- Its own migration so it can wait for the desktop release: a client that
-- predates the cloaks doesn't know the items, so this lands with (or
-- after) the desktop beta that does, not with 00123.
--
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
