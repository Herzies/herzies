-- The Greedy Spirit is sold for money only, as a Stripe product whose
-- metadata.item_id is 'spirit-orb'. It is the one item that cannot be earned
-- by playing (NON_DROPPABLE_ITEM_IDS), so leaving a coin price would have
-- made it grindable after all — and at 50000 coins, only just.
--
-- Mirrors the catalog, where its buyPrice is likewise gone. Until the Stripe
-- product exists it simply isn't for sale, which is the correct state for a
-- thing with no configured price.
UPDATE public.items SET buy_price = NULL WHERE id = 'spirit-orb';
