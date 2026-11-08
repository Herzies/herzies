-- Fabulous Fabian (FF) becomes an in-game clothing brand. Its first piece,
-- the black cap, keeps its id (fabulous-fabian) and is renamed FF Hat; five
-- more rare pieces join it, +10 luck each: FF Sneakers (feet), FF Cloak
-- (back), FF Pearls (body), FF Shades (face) and FF Pink (a skin,
-- see-through in 3D). Wearing all six adds another +10 luck (a set bonus,
-- computed in TypeScript like every stat). Drop-only, like the hat: they join the listening pool (read
-- from this table, less NON_DROPPABLE_ITEM_IDS) and a boss's random loot,
-- and no shop stocks them.
--
-- The catalog rows mirror packages/shared/src/items.ts, and boss_loot_roll's
-- weights mirror bossLootWeights() there (items.test.ts checks they agree):
-- rare's drop weight 25, times the boss's rare boost 2. Apply with or after
-- the desktop release that knows the items, so older clients never receive
-- them.

UPDATE public.items
   SET name = 'FF Hat',
       description = 'Fabulous Fabian''s first hat. Increases your chances of getting into a cool club.'
 WHERE id = 'fabulous-fabian';

INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot)
VALUES
  ('ff-sneakers-black', 'FF Sneakers', 'Fabulous Fabian''s first sneakers', 'rare', 250, NULL, false, true, 'feet'),
  ('ff-cloak-black', 'FF Cloak', 'Fabulous Fabian first cloak', 'rare', 250, NULL, false, true, 'back'),
  ('ff-pearls-marble', 'FF Pearls', 'Fabulous Fabian''s first marbled pearls', 'rare', 250, NULL, false, true, 'body'),
  ('ff-shades', 'FF Shades', 'Fabulous Fabian first shades', 'rare', 250, NULL, false, true, 'face'),
  ('ff-pink', 'FF Pink', 'Fabulous Fabian''s signature pink skin', 'rare', 250, NULL, false, true, 'color')
ON CONFLICT (id) DO NOTHING;

-- As 00134, with the five in the pool.
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
      ('ff-pink', 50)
    ) AS p(item_id, weight)
   ORDER BY -ln(1 - random()) / p.weight
   LIMIT 1;
$$;

revoke execute on function public.boss_loot_roll() from public, anon, authenticated;
