-- fulfill_store_order is server-only (called by the Stripe webhook via the
-- admin/service-role client) but, unlike every other server-only SECURITY
-- DEFINER function in this codebase (00008_security_hardening.sql,
-- 00038_hint_audio.sql), it was never revoked from PUBLIC and had no
-- search_path pinned. Left as-is, any authenticated user could call the RPC
-- directly with a session_id from their own (unpaid) pending order and
-- credit themselves currency without Stripe ever being involved.
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.fulfill_store_order(text, text) FROM PUBLIC;
