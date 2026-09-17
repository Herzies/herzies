/**
 * `collect-drop` Edge Function — manually collects a pending world drop.
 *
 * New functionality (not a port of an existing Next.js route) — new work
 * defaults to Edge Functions per the ongoing migration off Vercel (see
 * `sync`/`trade-pending`/`events-active`/`chat`).
 *
 * The claim/grant itself is atomic inside `collect_pending_drop` (see the
 * migration that defines it). The one piece of game logic here is the bank
 * capacity check — `collect_pending_drop` credits inventory unconditionally,
 * and an over-capacity item stays owned but has no grid slot to render in, so
 * it would vanish from view. See `hasRoomFor` in ../_shared/shared/game-rules.ts.
 */
import { createClient } from "@supabase/supabase-js";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import {
  type BankItemLookup,
  getItem,
  hasRoomFor,
} from "../_shared/shared/game-rules.ts";

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

  let dropId: string;
  try {
    const body = await request.json();
    if (typeof body?.dropId !== "string" || !body.dropId) {
      return jsonResponse({ error: "Missing dropId" }, 400);
    }
    dropId = body.dropId;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Refuse if the bank can't hold it. Without this, an over-capacity item is
    // still credited to inventory_v2 but the desktop grid has no slot to draw
    // it in, so it silently disappears from view (see reconcileSlotOrder) while
    // remaining owned and unsellable. The drop stays pending — they never
    // expire — so refusing loses nothing.
    const [{ data: dropRow }, { data: herzieRow }] = await Promise.all([
      admin
        .from("pending_drops")
        .select("item_id")
        .eq("id", dropId)
        .eq("user_id", user.id)
        .maybeSingle(),
      admin
        .from("herzies")
        .select("inventory_v2, equipped")
        .eq("user_id", user.id)
        .maybeSingle(),
    ]);

    if (dropRow && herzieRow) {
      const inventory = (herzieRow.inventory_v2 ?? {}) as Record<string, number>;
      const incoming = dropRow.item_id as string;
      // `stackable` comes from the items table; `category` isn't a column, and
      // every catalog item is "deck" today (see ItemCategory in
      // @herzies/shared). If a non-deck item is ever added, this needs a
      // category column or it will over-count slots relative to the client.
      const { data: itemRows } = await admin
        .from("items")
        .select("id, stackable")
        .in("id", [...Object.keys(inventory), incoming]);
      const stackableById = new Map(
        (itemRows ?? []).map((r) => [r.id as string, !!r.stackable]),
      );
      const lookup: BankItemLookup = (id) => ({
        stackable: stackableById.get(id) ?? false,
        category: "deck",
      });

      if (!hasRoomFor(inventory, herzieRow.equipped, incoming, lookup)) {
        return jsonResponse(
          { error: "Inventory full", reason: "inventory-full" },
          409,
        );
      }
    }

    const { data: itemId, error } = await admin.rpc("collect_pending_drop", {
      p_user_id: user.id,
      p_drop_id: dropId,
    });

    if (error) {
      return jsonResponse({ error: error.message }, 500);
    }

    if (!itemId) {
      return jsonResponse({ collected: null });
    }

    // Resolve a human-readable name for the desktop app's activity log from
    // the shared catalog every client displays, falling back to the items row
    // and then the id — mirrors processSync's song-hunt reward lookup.
    let name = getItem(itemId as string)?.name;
    if (!name) {
      const { data: itemRow } = await admin
        .from("items")
        .select("name")
        .eq("id", itemId)
        .maybeSingle();
      name = (itemRow?.name as string | undefined) ?? (itemId as string);
    }

    return jsonResponse({ collected: { itemId, name } });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
