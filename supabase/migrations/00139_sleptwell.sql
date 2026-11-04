-- Sleptwell: a cat spirit, mirroring packages/shared/src/items.ts.
--
-- A legendary in the 'spirit' slot (00099) that walks after its herzie in
-- the Town instead of floating. Like the Greedy Spirit and Herman it picks
-- up drops (any worn spirit does, in the sync) and is sold for money only,
-- as a Stripe product whose metadata.item_id is 'sleptwell': buy_price NULL,
-- never dropped (NON_DROPPABLE_ITEM_IDS in the catalog). It is also handed
-- out as a song hunt reward (events.config.rewardItemId).

INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot, min_stage, required_class)
VALUES
  ('sleptwell', 'Sleptwell', 'Fetches what you drop. Naps where you stop.',
   'legendary', 500, NULL, false, true, 'spirit', NULL, NULL)
ON CONFLICT (id) DO NOTHING;
