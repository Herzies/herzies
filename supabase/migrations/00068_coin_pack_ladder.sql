-- Replace the two-pack store with a three-tier ladder.
--
--    10000 coins —  10.00 kr — 1000 coins/kr
--    55000 coins —  40.00 kr — 1375 coins/kr  (clears the Greedy Spirit at 50k)
--   110000 coins —  75.00 kr — 1467 coins/kr  (clears Poseidon's Gift at 100k)
--
-- Value per krone rises with each tier, and every tier lands on a real
-- purchase target with change to spare, so nothing in the store needs repeat
-- checkouts of the same SKU any more.
--
-- The old 1000-coin pack is retired rather than repriced: the cheapest item
-- in the store costs 8000 coins, so that pack could not buy anything at all —
-- it took eight purchases (40.00 kr) to afford what one 10.00 kr pack covers.
--
-- New rows rather than edits in place, for two reasons. store_orders.product_id
-- is a foreign key onto this table, so the legacy rows have to keep existing
-- for order history; and their ids are actively misleading ('coins-500' grants
-- 1000 coins, 'coins-1200' grants 10000). The three live products now have ids
-- that state their own coin count, and the misleading pair becomes inert.
--
-- Names deliberately avoid repeating the coin count: StoreView already renders
-- "10,000 coins · kr 10,00" directly beneath the name.

INSERT INTO public.store_products
  (id, name, description, currency_amount, stripe_price_id, price_nok_ore, active)
VALUES
  (
    'coins-10000',
    'Handful of Coins',
    'A handful of coins.',
    10000,
    'price_1UH62xASewMoCrCWADriLvbY',
    1000,
    true
  ),
  (
    'coins-55000',
    'Pouch of Coins',
    'A pouch of coins — better value.',
    55000,
    'price_1UH64OASewMoCrCWP8igWI9b',
    4000,
    true
  ),
  (
    'coins-110000',
    'Hoard of Coins',
    'A hoard of coins — best value.',
    110000,
    'price_1UH65KASewMoCrCWsgE6oczm',
    7500,
    true
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  currency_amount = EXCLUDED.currency_amount,
  stripe_price_id = EXCLUDED.stripe_price_id,
  price_nok_ore = EXCLUDED.price_nok_ore,
  active = EXCLUDED.active;

-- Retire the legacy pair. Kept, not deleted, for the store_orders FK.
UPDATE public.store_products
SET active = false
WHERE id IN ('coins-500', 'coins-1200');
