-- Supabase auto-grants EXECUTE on newly-created/replaced public-schema
-- functions directly to anon and authenticated (independent of PUBLIC), so
-- the REVOKE ... FROM PUBLIC in 00050 didn't fully lock this down. Revoke
-- from all three explicitly, matching increment_hint_play's actual grant
-- state (postgres + service_role only).
REVOKE EXECUTE ON FUNCTION public.fulfill_store_order(text, text) FROM PUBLIC, anon, authenticated;
