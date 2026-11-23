-- The Sailor's Starter Pack (face): a walrus moustache and a briar pipe,
-- the skipper's at the Sky Dock. Uncommon, +10 luck, drop-only: it joins the
-- listening/Crystal pool (read from this table, less NON_DROPPABLE_ITEM_IDS)
-- and a boss's random loot at the uncommon weight (150 x the boss's uncommon
-- boost of 1.5).
--
-- The catalog row mirrors packages/shared/src/items.ts, and boss_loot_roll's
-- weights mirror bossLootWeights() there (items.test.ts checks they agree).
-- Apply with or after the desktop release that knows the item, so older
-- clients never receive it.

INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot)
VALUES
  ('sailors-starter-pack', 'Sailor''s Starter Pack', 'A walrus moustache and a briar pipe. Sea legs sold separately', 'uncommon', 100, NULL, false, true, 'face')
ON CONFLICT (id) DO NOTHING;

-- As 00151, with the pack in the pool.
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
      ('drumhide-boots', 6),
      ('sailors-starter-pack', 225)
    ) AS p(item_id, weight)
   ORDER BY -ln(1 - random()) / p.weight
   LIMIT 1;
$$;

revoke execute on function public.boss_loot_roll() from public, anon, authenticated;
