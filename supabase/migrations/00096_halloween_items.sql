-- Halloween items, mirroring the new entries in packages/shared/src/items.ts:
-- Hex Appeal (witch hat), Fang Club (fangs, the first face-slot item),
-- Pumpkin Spice (skin), Jack (jack-o'-lantern pet), Boo-tleg (ghost pet),
-- Blood Moon (scenery) and Trick or Treat (+5 luck modifier).
--
-- Seasonal: they only drop between Oct 20 and Nov 2. That window lives in the
-- catalog (ItemDef.dropWindow, HALLOWEEN_DROP_WINDOW), not here —
-- filterDroppablePool drops out-of-season rows from the pool this table
-- feeds, so outside the window these rows are simply never rolled. Copies
-- players own are unaffected.
--
-- No buy_price: drop-only, like the other cosmetics.
INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot)
VALUES
  ('witch-hat', 'Hex Appeal', 'A pointy hat with a floppy tip. Spin your herzie and watch it go.', 'uncommon', 100, NULL, false, true, 'head'),
  ('fangs', 'Fang Club', 'Two little fangs. Your herzie vants to suck your playlist.', 'uncommon', 100, NULL, false, true, 'face'),
  ('pumpkin-spice', 'Pumpkin Spice', 'Candle-lit orange down to a dark rind. Very seasonal.', 'uncommon', 100, NULL, false, true, 'color'),
  ('jack-o-lantern', 'Jack', 'A carved pumpkin that floats along beside your herzie, grinning.', 'rare', 250, NULL, false, true, 'ground'),
  ('ghost', 'Boo-tleg', 'A friendly little sheet ghost. Haunts your herzie, nicely.', 'rare', 250, NULL, false, true, 'ground'),
  ('blood-moon', 'Blood Moon', 'Hangs a huge red moon in your herzie''s sky. Bats included.', 'rare', 250, NULL, false, true, 'scenery'),
  ('trick-or-treat', 'Trick or Treat', 'A pocketful of sweets. Somehow the drops feel luckier.', 'uncommon', 100, NULL, false, true, 'modifier')
ON CONFLICT (id) DO NOTHING;
