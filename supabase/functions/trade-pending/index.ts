/**
 * `trade-pending` Edge Function — port of `GET /api/trade/pending` from the
 * Next.js game server.
 *
 * This is polled unconditionally by the desktop client's `trade_watch_loop`
 * every 5s whenever the menu-bar window is hidden, which made it one of the
 * largest sources of Vercel invocation/observability volume alongside
 * `/sync` and `/chat` (already migrated) — moving it here removes that
 * background traffic from Vercel entirely.
 *
 * Only the platform glue (HTTP, auth) lives here; the query itself has no
 * game logic worth vendoring into `_shared/game-server.ts`.
 */
import { createClient } from "@supabase/supabase-js";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // --- Authenticate the caller's access token ---
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse(
      { error: "Missing or invalid Authorization header" },
      401,
    );
  }
  const token = authHeader.slice(7);

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser(token);

  if (authError || !user) {
    return jsonResponse({ error: "Invalid or expired token" }, 401);
  }

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // No expire_stale_trades() call here: the query below already filters on
    // expires_at, so the sweep never changed this result. It runs on pg_cron
    // now (00057_expire_stale_trades_cron.sql). This endpoint is polled every
    // 5s per hidden client, so it was the single largest source of those
    // writes.

    // Check for pending trades where this user is the target
    const { data: pending } = await admin
      .from("trades")
      .select("id, initiator_id")
      .eq("target_id", user.id)
      .eq("state", "pending")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!pending) {
      return jsonResponse({ pending: null });
    }

    const { data: initiator } = await admin
      .from("herzies")
      .select("name, friend_code")
      .eq("user_id", pending.initiator_id)
      .single();

    return jsonResponse({
      pending: {
        tradeId: pending.id,
        fromName: initiator?.name ?? "Unknown",
        fromFriendCode: initiator?.friend_code ?? "",
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
