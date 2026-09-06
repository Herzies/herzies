-- 00008_security_hardening.sql revoked EXECUTE from anon/authenticated, but
-- never from PUBLIC. Every role implicitly inherits PUBLIC's grants, so the
-- original revoke never actually took effect: grant_cds, grant_inventory_item
-- and expire_stale_trades remained callable by anon (unauthenticated)
-- requests, and add_friend/remove_friend/execute_trade remained callable by
-- anon despite the explicit "FROM anon" revoke. Confirmed via
-- mcp__supabase__get_advisors and has_function_privilege().
--
-- grant_inventory_item and grant_cds are especially serious: anyone,
-- including unauthenticated callers, could mint arbitrary items/currency
-- into any user's inventory for free, undermining the real-money store.
--
-- Revoking from all three of PUBLIC/anon/authenticated explicitly (rather
-- than relying on ordering against CREATE OR REPLACE's auto-grant to
-- anon/authenticated) so this reproduces correctly on a fresh database.
REVOKE EXECUTE ON FUNCTION public.grant_cds(uuid, int, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.grant_inventory_item(uuid, text, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.expire_stale_trades() FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.add_friend(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_friend(text, text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.remove_friend(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_friend(text, text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.execute_trade(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.execute_trade(uuid) TO authenticated;
