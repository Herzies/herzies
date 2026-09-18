-- Reshape the coin shop into "cheap earnable skins" and nothing else.
--
-- Out: the two head cosmetics. They stay in the drop pool, earned only.
-- In:  Prismatic Surrenderer, at the same 3000 as the other skins.
-- Changed: Poseidon's Gift becomes an ordinary uncommon at 3000, down from a
--          legendary at 100000.
--
-- Mirrors packages/shared/src/items.ts, which the desktop store reads for
-- display; these rows are what actually gets charged.
--
-- NOTE the knock-on effects of the Poseidon's Gift rarity change, both
-- intended-or-not rather than incidental:
--   * Its drop rate rises ~50x, from the legendary weight (3, about 270h of
--     listening) to the uncommon weight (150, about 5.4h).
--   * The droppable legendary tier is now EMPTY — Greedy Spirit is the only
--     other legendary and it is in NON_DROPPABLE_ITEM_IDS. RARITY_DROP_WEIGHTS
--     still has a legendary entry, but nothing in the pool can use it.
--   * It leaves CONFIRM_SELL_RARITIES, so it no longer asks before being sold
--     and spare copies are now eligible for the Sell duplicates button.
--   * Its sell_price stays 500 while every other uncommon sells for 100,
--     making it by far the most valuable uncommon to sell. Not exploitable
--     (it costs 3000 to buy), but deliberate to leave, not an oversight.

UPDATE public.items SET buy_price = NULL
WHERE id IN ('headphones', 'rainbow-headband');

UPDATE public.items SET buy_price = 3000
WHERE id = 'prism';

UPDATE public.items SET buy_price = 3000, rarity = 'uncommon'
WHERE id = 'poseidons-gift';
