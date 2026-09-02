-- 00033_item_buy_price.sql only backfilled buy_price for 'headphones', leaving
-- rainbow-headband unpurchasable in the store despite items.ts setting buyPrice: 1000.
UPDATE public.items SET buy_price = 1000 WHERE id = 'rainbow-headband';

-- Rename to match packages/shared/src/items.ts.
UPDATE public.items
SET name = 'Permanent Rainbow Dreams',
    description = 'Rainbows forever on your mind. And head.'
WHERE id = 'rainbow-headband';
