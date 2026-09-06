-- The Stripe prices for these products are actually denominated in NOK
-- (20.00 kr / 60.00 kr), not USD as price_usd_cents implied. Rename the
-- column and correct the values to match Stripe.
ALTER TABLE public.store_products RENAME COLUMN price_usd_cents TO price_nok_ore;

UPDATE public.store_products
SET price_nok_ore = 2000
WHERE id = 'coins-500';

UPDATE public.store_products
SET price_nok_ore = 6000
WHERE id = 'coins-1200';
