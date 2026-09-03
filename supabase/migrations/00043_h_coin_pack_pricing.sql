-- Replace the placeholder H coin pack pricing from 00032 with real values:
-- 1000 coins for $1.99, 10000 coins for $5.99. IDs are left unchanged
-- (renaming the primary key would violate the store_orders FK — test-mode
-- completed orders already reference 'coins-500'/'coins-1200').
UPDATE public.store_products
SET name = '1000 Coins',
    currency_amount = 1000,
    stripe_price_id = 'price_REPLACE_ME_1000',
    price_usd_cents = 199
WHERE id = 'coins-500';

UPDATE public.store_products
SET name = '10000 Coins',
    currency_amount = 10000,
    stripe_price_id = 'price_REPLACE_ME_10000',
    price_usd_cents = 599
WHERE id = 'coins-1200';
