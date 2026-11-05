/**
 * `attune-crystal` Edge Function — cash in the Crystal (00140).
 *
 * Body: `{ attunes: number }`, the crystal_attunes the client last saw. A
 * retry or a double press arrives stale and pays nothing (the response then
 * carries the current Crystal so the client can catch up).
 *
 * The game logic is `attuneCrystal` in the shared game server: drops are
 * rolled here, then granted together with the XP handoff in one locked
 * transaction (crystal_attune). Only HTTP, auth and validation live here.
 */
import { createClient } from "@supabase/supabase-js";
import {
  attuneCrystal,
  crystalEnabled,
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

  let attunes: number;
  try {
    const body = await request.json();
    if (!Number.isInteger(body?.attunes) || body.attunes < 0) {
      return jsonResponse({ error: "Missing attunes" }, 400);
    }
    attunes = body.attunes;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const enabled = await crystalEnabled(admin);
    const result = await attuneCrystal(admin, user.id, attunes, {
      crystalEnabled: enabled,
    });
    if (!result.ok && result.reason === "not-found") {
      return jsonResponse({ error: "Herzie not found" }, 404);
    }
    return jsonResponse(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
