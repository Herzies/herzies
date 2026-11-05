/**
 * `upgrade-crystal` Edge Function — spend Crystal Shards to grow the Crystal
 * one tier (upgrade_crystal, 00140). No body. The cost check and the spend
 * happen together under a row lock in SQL.
 */
import { createClient } from "@supabase/supabase-js";
import {
  crystalEnabled,
  upgradeCrystal,
} from "../_shared/shared/game-server.ts";
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

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const enabled = await crystalEnabled(admin);
    return jsonResponse(
      await upgradeCrystal(admin, user.id, { crystalEnabled: enabled }),
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
