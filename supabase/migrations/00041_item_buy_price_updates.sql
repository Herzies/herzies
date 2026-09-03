-- Store price tuning: both headband items now cost 8000, matching
-- packages/shared/src/items.ts.
UPDATE public.items SET buy_price = 8000 WHERE id = 'headphones';
UPDATE public.items SET buy_price = 8000 WHERE id = 'rainbow-headband';
