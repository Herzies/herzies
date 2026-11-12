-- The Streetsmart set: six rare pieces, +10 luck each: the Fisherman Beanie
-- (head), the Hipster Moustache (face), the Dollar Chain (body), the Camo
-- Cloak (back), the Shiny Loafers (feet) and Latte (a skin). Wearing all six
-- adds another +10 luck and coffee bubbles (a set bonus, computed in
-- TypeScript like every stat). Drop-only, like Fabulous Fabian: they join the
-- listening pool (read from this table, less NON_DROPPABLE_ITEM_IDS) and a
-- boss's random loot, and no shop stocks them.
--
-- The catalog rows mirror packages/shared/src/items.ts, and boss_loot_roll's
-- weights mirror bossLootWeights() there (items.test.ts checks they agree):
-- rare's drop weight 25, times the boss's rare boost 2. Apply with or after
-- the desktop release that knows the items, so older clients never receive
-- them.

INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot)
VALUES
  ('fisherman-beanie', 'Fisherman Beanie', 'A short red watch cap. Has never been near a boat.', 'rare', 250, NULL, false, true, 'head'),
  ('hipster-moustache', 'Hipster Moustache', 'A handlebar, waxed daily. Grown before it was cool.', 'rare', 250, NULL, false, true, 'face'),
  ('dollar-chain', 'Dollar Chain', 'Gold, heavy, and worn ironically. Probably.', 'rare', 250, NULL, false, true, 'body'),
  ('camo-cloak', 'Camo Cloak', 'Woodland camo with a blaze-orange lining. Blends in, stands out.', 'rare', 250, NULL, false, true, 'back'),
  ('shiny-loafers', 'Shiny Loafers', 'Polished oxblood penny loafers. No socks.', 'rare', 250, NULL, false, true, 'feet'),
  ('latte', 'Latte', 'A light, milky coffee skin with a head of foam. Oat, obviously.', 'rare', 250, NULL, false, true, 'color')
ON CONFLICT (id) DO NOTHING;

-- As 00145, with the six in the pool.
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
      ('eivinds-evasive-pair', 2),
      ('ff-sneakers-black', 50),
      ('ff-cloak-black', 50),
      ('ff-pearls-marble', 50),
      ('ff-shades', 50),
      ('ff-pink', 50),
      ('fisherman-beanie', 50),
      ('hipster-moustache', 50),
      ('dollar-chain', 50),
      ('camo-cloak', 50),
      ('shiny-loafers', 50),
      ('latte', 50)
    ) AS p(item_id, weight)
   ORDER BY -ln(1 - random()) / p.weight
   LIMIT 1;
$$;

revoke execute on function public.boss_loot_roll() from public, anon, authenticated;
