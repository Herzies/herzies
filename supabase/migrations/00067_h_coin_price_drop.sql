-- Repricing both H Coin packs, with new Stripe price IDs to match.
--
--   1000 coins: 20.00 kr -> 5.00 kr
--  10000 coins: 60.00 kr -> 10.00 kr
--
-- Amounts are minor units (øre), as Stripe denominates them: 500 and 1000.
--
-- The row ids are historically misleading — 'coins-500' grants 1000 coins and
-- 'coins-1200' grants 10000 — so each UPDATE also matches on currency_amount.
-- That is a guard, not a filter: if the id/amount pairing is ever not what is
-- assumed here, the statement touches no rows instead of repricing the wrong
-- pack. checkout/route.ts hands stripe_price_id straight to Stripe, so a
-- mismatch here charges real money at the wrong price.

-- 1000 coins, now 5.00 kr
UPDATE public.store_products
SET price_nok_ore = 500,
    stripe_price_id = 'price_1UH20nASewMoCrCWVKn9RhXz'
WHERE id = 'coins-500' AND currency_amount = 1000;

-- 10000 coins, now 10.00 kr
UPDATE public.store_products
SET price_nok_ore = 1000,
    stripe_price_id = 'price_1UH20MASewMoCrCWPTnkjiO9'
WHERE id = 'coins-1200' AND currency_amount = 10000;
