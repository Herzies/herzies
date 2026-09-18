-- Two halves of the same repositioning: coins become the currency for
-- earnable cosmetics only, and real money moves to a separate curated store.

-- 1. Bring the coin-priced cosmetics within reach of a newish player. The
-- average balance across all players is ~2,600 coins and the richest holds
-- 13,500, so at 8000-10000 nobody but the top player could buy anything at
-- all. At 2500/3000 a typical player can afford one now. The head/skin
-- ordering is preserved (heads were the cheaper pair).
--
-- Must stay in step with buyPrice in packages/shared/src/items.ts: the
-- desktop store *displays* the bundled catalog's price but *charges* this
-- one, so a mismatch shows players the wrong number. Lowering here first is
-- the safe direction — a stale client over-quotes rather than under-quotes.
UPDATE public.items SET buy_price = 2500 WHERE id IN ('headphones', 'rainbow-headband');
UPDATE public.items SET buy_price = 3000 WHERE id IN ('purple-dane', 'thanks-for-all-the-fish');

-- 2. Retire every coin pack. Coins are now earned, never bought: with the
-- premium store moving to kroner-priced items, a coin pack would be selling
-- pure trade currency, which is murkier than selling the item outright.
--
-- Deactivated rather than deleted — store_orders.product_id is a foreign key
-- onto this table and past orders have to keep resolving.
UPDATE public.store_products SET active = false;
