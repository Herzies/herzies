-- Lets items be purchased with in-game currency (store's Items tab), separate
-- from the sell_price column which is the item -> currency direction.
ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS buy_price integer DEFAULT NULL
    CHECK (buy_price IS NULL OR buy_price > 0);

UPDATE public.items SET buy_price = 250 WHERE id = 'headphones';
