-- Replace the placeholder Stripe price IDs from 00043 with the real prices
-- created in the Stripe dashboard.
UPDATE public.store_products
SET stripe_price_id = 'price_1UCDfaASewMoCrCWvS2eU6yV'
WHERE id = 'coins-500';

UPDATE public.store_products
SET stripe_price_id = 'price_1UCDgJASewMoCrCWiA0CICIN'
WHERE id = 'coins-1200';
