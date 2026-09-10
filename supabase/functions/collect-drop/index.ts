/**
 * `collect-drop` Edge Function — manually collects a pending world drop.
 *
 * New functionality (not a port of an existing Next.js route) — new work
 * defaults to Edge Functions per the ongoing migration off Vercel (see
 * `sync`/`trade-pending`/`events-active`/`chat`).
 *
 * Only the platform glue (HTTP, auth) lives here; the actual claim/grant is
 * atomic inside `collect_pending_drop` (see the migration that defines it) so
 * this function has no game logic worth vendoring, matching `trade-pending`.
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
  if (request.method !== "POST") {
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

    const { data: itemId, error } = await admin.rpc("collect_pending_drop", {
      p_user_id: user.id,
    });

    if (error) {
      return jsonResponse({ error: error.message }, 500);
    }

    if (!itemId) {
      return jsonResponse({ collected: null });
    }

    return jsonResponse({ collected: { itemId } });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
