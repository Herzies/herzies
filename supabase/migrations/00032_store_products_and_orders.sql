-- Microtransaction store: currency-pack products + orders, fulfilled by a
-- Stripe webhook (never by the client) via the atomic/idempotent RPC below.

-- 1. Product catalog (currency packs for now; extensible to item SKUs later)
CREATE TABLE IF NOT EXISTS public.store_products (
  id text PRIMARY KEY,                 -- e.g. 'coins-500'
  name text NOT NULL,
  description text,
  currency_amount integer NOT NULL CHECK (currency_amount > 0),
  stripe_price_id text NOT NULL,       -- price_xxx from the Stripe dashboard
  price_usd_cents integer NOT NULL CHECK (price_usd_cents > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.store_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read active products" ON public.store_products;
CREATE POLICY "Anyone can read active products"
  ON public.store_products FOR SELECT
  USING (active = true);

-- Seed the first two products. Swap stripe_price_id for real Stripe Price
-- IDs (test-mode locally, live-mode in prod) before this is usable.
INSERT INTO public.store_products (id, name, description, currency_amount, stripe_price_id, price_usd_cents)
VALUES
  ('coins-500', '500 Coins', 'A handful of coins.', 500, 'price_REPLACE_ME_500', 299),
  ('coins-1200', '1200 Coins', 'A pouch of coins — better value.', 1200, 'price_REPLACE_ME_1200', 599)
ON CONFLICT (id) DO NOTHING;

-- 2. Orders — one row per Stripe Checkout Session, tracking fulfillment.
CREATE TABLE IF NOT EXISTS public.store_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  product_id text NOT NULL REFERENCES public.store_products(id),
  stripe_checkout_session_id text UNIQUE NOT NULL,
  stripe_event_id text UNIQUE,          -- set once the fulfilling webhook event is processed
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'expired', 'failed')),
  currency_amount integer NOT NULL,     -- snapshot at creation time
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_store_orders_user ON public.store_orders(user_id);

ALTER TABLE public.store_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can see own orders" ON public.store_orders;
CREATE POLICY "Users can see own orders"
  ON public.store_orders FOR SELECT
  USING (auth.uid() = user_id);

-- 3. Atomic, idempotent fulfillment — same row-lock-then-mutate shape as
-- execute_trade() in 00002_currency_trading.sql. Safe against Stripe
-- redelivering the same event: the UNIQUE constraints above plus the
-- early-return on an already-completed order make this a no-op on retry.
CREATE OR REPLACE FUNCTION public.fulfill_store_order(
  p_session_id text,
  p_event_id text
)
RETURNS boolean AS $$
DECLARE
  o public.store_orders;
BEGIN
  SELECT * INTO o FROM public.store_orders
    WHERE stripe_checkout_session_id = p_session_id FOR UPDATE;

  IF NOT FOUND THEN RETURN false; END IF;
  IF o.status = 'completed' THEN RETURN true; END IF;

  UPDATE public.herzies
    SET currency = currency + o.currency_amount
    WHERE user_id = o.user_id;

  UPDATE public.store_orders
    SET status = 'completed', stripe_event_id = p_event_id, completed_at = now()
    WHERE id = o.id;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
