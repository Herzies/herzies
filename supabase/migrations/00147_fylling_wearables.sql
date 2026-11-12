-- Fylling's range grows to match his fedora: a necktie (body), loafers
-- (feet), a cape (back), a monocle (face) and a 70s green skin (color). All
-- rare, +10 luck each, drop-only like the fedora: they join the listening
-- pool (read from this table, less NON_DROPPABLE_ITEM_IDS) and a boss's
-- random loot, and no shop stocks them. No set bonus yet.
--
-- The catalog rows mirror packages/shared/src/items.ts, and boss_loot_roll's
-- weights mirror bossLootWeights() there (items.test.ts checks they agree).
-- Apply with or after the desktop release that knows the items, so older
-- clients never receive them.

INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot)
VALUES
  ('fyllings-necktie', 'Fylling''s Necktie', 'Slightly too tight. Fylling says that is the point.', 'rare', 250, NULL, false, true, 'body'),
  ('fyllings-loafers', 'Fylling''s Loafers', 'Polished enough to see your own disappointment in.', 'rare', 250, NULL, false, true, 'feet'),
  ('fyllings-cape', 'Fylling''s Cape', 'For entering rooms a few seconds after everyone else.', 'rare', 250, NULL, false, true, 'back'),
  ('fyllings-monocle', 'Fylling''s Monocle', 'Lets you look down on things with just the one eye.', 'rare', 250, NULL, false, true, 'face'),
  ('fyllings-green', 'Fylling''s Green', 'A proper seventies green. It was in fashion once, and Fylling never forgot.', 'rare', 250, NULL, false, true, 'color')
ON CONFLICT (id) DO NOTHING;

-- As 00145, with the five Fylling pieces in the pool.
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
      ('fyllings-green', 50),
      ('eivinds-evasive-pair', 2),
      ('ff-sneakers-black', 50),
      ('ff-cloak-black', 50),
      ('ff-pearls-marble', 50),
      ('ff-shades', 50),
      ('ff-pink', 50)
    ) AS p(item_id, weight)
   ORDER BY -ln(1 - random()) / p.weight
   LIMIT 1;
$$;

revoke execute on function public.boss_loot_roll() from public, anon, authenticated;
