/**
 * `debug-spawn-drop` Edge Function — spawns a real, pickup-able world drop
 * for the caller on demand, powering the dev-only "Spawn Item Drop" button
 * in Settings (`SettingsView.tsx`, `import.meta.env.DEV`-gated).
 *
 * That client-side gate is cosmetic only — this endpoint is reachable by any
 * authenticated request, same as every other edge function — so it is
 * additionally locked to OWNER_USER_ID, Mathias's own account. Without that,
 * any real player could call this directly (bypassing the dev-only UI) to
 * spawn free items into their own inventory indefinitely — a real economy
 * exploit given items have sellPrice/buyPrice and a live store/trade system.
 *
 * Picks from the same weighted pool `processSync` rolls from (see
 * `_shared/herzies-shared.ts`), then inserts straight into `pending_drops`
 * (rather than going through the `roll_pending_drop` RPC) so the inserted
 * row — including its id — can be returned to the caller for immediate
 * display, instead of waiting for the next sync tick to pick it up.
 */
import { createClient } from "@supabase/supabase-js";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import {
  filterDroppablePool,
  NON_DROPPABLE_ITEM_IDS,
  pickWeightedDrop,
} from "../_shared/herzies-shared.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Mathias's own user id (auth.users.email = novasism@gmail.com) — see the
// module doc comment for why this endpoint is restricted to it.
const OWNER_USER_ID = "920a6cf8-3f1c-4274-b549-39d976ee6ee0";

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

  if (user.id !== OWNER_USER_ID) {
    return jsonResponse({ error: "Not available for this account" }, 403);
  }

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: pool } = await admin
      .from("items")
      .select("id, rarity")
      .not(
        "id",
        "in",
        `(${NON_DROPPABLE_ITEM_IDS.map((id) => `"${id}"`).join(",")})`,
      );
    const picked = pool ? pickWeightedDrop(filterDroppablePool(pool)) : undefined;
    if (!picked) {
      return jsonResponse({ error: "No droppable items in the pool" }, 500);
    }

    const { data: row, error } = await admin
      .from("pending_drops")
      .insert({ user_id: user.id, item_id: picked.id })
      .select("id, item_id, dropped_at")
      .single();

    if (error || !row) {
      return jsonResponse(
        { error: error?.message ?? "Insert failed" },
        500,
      );
    }

    return jsonResponse({
      spawned: {
        id: row.id as string,
        itemId: row.item_id as string,
        droppedAt: row.dropped_at as string,
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
