-- Two rare luck hats, +10 luck each: Fabulous Fabian (a black cap with a pink
-- F) and Fylling's Fedora. Drop-only: they join the listening pool
-- (read from this table, less NON_DROPPABLE_ITEM_IDS) and a boss's random
-- loot, and Boboku doesn't stock them.
--
-- The catalog rows mirror the new entries in packages/shared/src/items.ts, and
-- boss_loot_roll's weights mirror bossLootWeights() there (items.test.ts
-- checks they agree). Apply with or after the desktop release that knows the
-- items, so older clients never receive them.

INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot)
VALUES
  ('fabulous-fabian', 'Fabulous Fabian', 'Increases your chances of getting into a cool club.', 'rare', 250, NULL, false, true, 'head'),
  ('fyllings-fedora', 'Fylling''s Fedora', 'Decreases your chances of getting into a cool club.', 'rare', 250, NULL, false, true, 'head')
ON CONFLICT (id) DO NOTHING;

-- As 00128, with the two in the pool.
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
      ('fyllings-fedora', 50)
    ) AS p(item_id, weight)
   ORDER BY -ln(1 - random()) / p.weight
   LIMIT 1;
$$;

revoke execute on function public.boss_loot_roll() from public, anon, authenticated;
