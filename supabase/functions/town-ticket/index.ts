/**
 * `town-ticket` Edge Function: the pass into the multiplayer Town.
 *
 * The Town server (a Cloudflare Durable Object, `packages/town-server`) has
 * no database access. It trusts whatever this function signs: the caller's
 * user id, herzie name and look, valid for ten minutes. The desktop app
 * fetches one before connecting and again to renew it or to show a new
 * outfit. Clients can't read `herzies` themselves, so the look has to come
 * from here (service role) — which also means nobody can walk around in
 * someone else's look.
 *
 * Kill switch: TOWN_MULTIPLAYER=off answers 503, and the app falls back to
 * an empty Town.
 */
import { createClient } from "@supabase/supabase-js";
import { normalizeEquipped } from "../_shared/shared/items.ts";
import {
  signTownTicket,
  TOWN_TICKET_TTL_S,
} from "../_shared/shared/town-net.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOWN_TICKET_SECRET = Deno.env.get("TOWN_TICKET_SECRET");
/** Where the Town server lives, so it can move without an app release. */
const TOWN_SERVER_URL = Deno.env.get("TOWN_SERVER_URL");

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  if (
    Deno.env.get("TOWN_MULTIPLAYER") === "off" ||
    !TOWN_TICKET_SECRET ||
    !TOWN_SERVER_URL
  ) {
    return jsonResponse({ error: "Multiplayer is off" }, 503);
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse(
      { error: "Missing or invalid Authorization header" },
      401,
    );
  }
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser(authHeader.slice(7));
  if (authError || !user) {
    return jsonResponse({ error: "Invalid or expired token" }, 401);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: herzie, error } = await admin
    .from("herzies")
    .select("name, friend_code, stage, equipped")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    return jsonResponse({ error: "Failed to load herzie" }, 500);
  }
  if (!herzie) {
    return jsonResponse({ error: "No herzie" }, 404);
  }

  // Ground accessories (the boombox) stay home, as in the app's own Town.
  const { ground_left: _l, ground_right: _r, ...equipped } = normalizeEquipped(
    herzie.equipped,
  );
  const exp = Math.floor(Date.now() / 1000) + TOWN_TICKET_TTL_S;
  const ticket = await signTownTicket(
    {
      uid: user.id,
      name: herzie.name,
      look: { seed: herzie.friend_code, stage: herzie.stage, equipped },
      exp,
    },
    TOWN_TICKET_SECRET,
  );
  return jsonResponse({ ticket, url: TOWN_SERVER_URL, exp });
});
