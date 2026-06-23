/**
 * `sync` Edge Function — port of `POST /api/sync` from the Next.js game server.
 *
 * This is the core game loop and the highest-traffic endpoint (the CLI daemon
 * calls it every ~10s per active user), which makes it the best first
 * candidate to move off Vercel: it's DB-bound, so co-locating it with Postgres
 * cuts a network round-trip per call, and it dominates serverless invocation
 * cost.
 *
 * The game logic lives in `../_shared/game-server.ts` (a self-contained copy
 * of `packages/web/src/lib/game-server.ts`, since the Supabase runtime can only
 * see files under `supabase/`) — only the platform glue (HTTP, auth,
 * validation) lives here.
 */
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { processSync } from "../_shared/game-server.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const syncRequestSchema = z.object({
  nowPlaying: z
    .object({
      title: z.string(),
      artist: z.string(),
      genre: z.string().optional(),
    })
    .nullable(),
  minutesListened: z.number().nonnegative().max(10),
  genres: z.array(z.string()).default([]),
});

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

  // --- Validate the request body ---
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const parsed = syncRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse({ error: parsed.error.issues[0].message }, 400);
  }
  const { nowPlaying, minutesListened, genres } = parsed.data;

  // --- Run the game loop (service role bypasses RLS) ---
  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const result = await processSync(
      admin,
      user.id,
      nowPlaying,
      minutesListened,
      genres,
    );

    return jsonResponse({
      herzie: result.herzie,
      notifications: result.notifications,
      multipliers: result.multipliers,
      pendingTradeRequest: result.pendingTradeRequest,
      pendingFriendRequest: result.pendingFriendRequest,
      incomingFriendRequests: result.incomingFriendRequests,
      outgoingFriendRequests: result.outgoingFriendRequests,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
