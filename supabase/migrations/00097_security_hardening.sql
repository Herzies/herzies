-- Security hardening from the 2026-10-05 audit.
--
-- Every write and every RPC below goes through the service role (the Next.js
-- API and the edge functions); clients only ever read. These grants and the
-- one policy let a signed-in user skip those servers and hit PostgREST
-- directly.

-- 1. SECURITY DEFINER functions callable straight from /rest/v1/rpc.
--    add_friend / remove_friend take both friend codes as arguments and never
--    look at auth.uid(), and friend codes are public (every chat message
--    carries its sender's), so anyone could befriend themselves to anyone —
--    unlocking their profile, listening history and trades — or wipe anyone's
--    friend list. The rest are harmless today but have no business being
--    public. EXECUTE is granted to PUBLIC by default, hence revoking from it too.
revoke execute on function public.add_friend(text, text) from public, anon, authenticated;
revoke execute on function public.remove_friend(text, text) from public, anon, authenticated;
revoke execute on function public.execute_trade(uuid) from public, anon, authenticated;
revoke execute on function public.delete_expired_chat_messages() from public, anon, authenticated;
revoke execute on function public.count_song_hunt_wins(uuid) from public, anon, authenticated;
revoke execute on function public.top_song_hunt_winners(integer) from public, anon, authenticated;
-- Trigger functions: firing a trigger needs no EXECUTE privilege.
revoke execute on function public.broadcast_chat_message() from public, anon, authenticated;
revoke execute on function public.broadcast_trade_request() from public, anon, authenticated;
revoke execute on function public.check_chat_content() from public, anon, authenticated;
revoke execute on function public.check_chat_rate_limit() from public, anon, authenticated;
revoke execute on function public.update_updated_at() from public, anon, authenticated;

-- New functions start closed; grant a client-facing RPC explicitly.
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;

-- 2. Direct chat inserts. Messages are sent through the `chat` edge function
--    (service role), which strips links/markup and checks mentions. Inserting
--    directly skipped all of that and let the client pick `created_at` — a
--    past one dodged the rate-limit trigger, a future one outlived retention.
drop policy if exists "Authenticated users can insert own chat messages"
  on public.chat_messages;

-- 3. Table write grants. RLS was the only thing stopping writes to tables
--    like spotify_connections, store_orders, items and trades; one permissive
--    policy added by mistake would have opened them. Clients only read, so
--    take writes away outright. SELECT grants (and the herzies column
--    grants) are untouched.
revoke insert, update, delete, truncate on all tables in schema public
  from anon, authenticated;
alter default privileges in schema public
  revoke insert, update, delete, truncate on tables from anon, authenticated;
