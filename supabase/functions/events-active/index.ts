/**
 * `events-active` Edge Function — port of `GET /api/events/active` from the
 * Next.js game server.
 *
 * The desktop client's `events_watch_loop` polls this every 30s, always
 * (window visible or hidden), which made it one of the largest sources of
 * Vercel invocation/observability volume alongside `/sync` and `/chat`
 * (already migrated) and `/trade/pending` — moving it here removes that
 * background traffic from Vercel entirely.
 *
 * Unlike the Next.js route, auth is required here (the desktop client always
 * sends a token, and this function's only caller is the desktop app), unlike
 * the Next.js route which also serves anonymous marketing-site callers.
 */
import { createClient } from "@supabase/supabase-js";
import type {
  BossFightConfig,
  GameEvent,
  SongHuntConfig,
} from "../_shared/shared/game-rules.ts";
import {
  buildBossFightConfig,
  buildSongHuntConfig,
} from "../_shared/shared/game-events.ts";
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
    const now = new Date();

    const { data, error } = await admin
      .from("events")
      .select("id, type, title, description, active, starts_at, ends_at, config")
      .eq("active", true)
      .lte("starts_at", now.toISOString())
      .gte("ends_at", now.toISOString());

    if (error) {
      return jsonResponse({ error: "Failed to fetch events" }, 500);
    }

    const events: GameEvent[] = await Promise.all(
      (data ?? []).map(async (e) => {
        let config: Record<string, unknown>;
        if (e.type === "secret_track") {
          config = {
            rewardItemId: (e.config as Record<string, unknown>).rewardItemId,
          };
        } else if (e.type === "song_hunt") {
          config = await buildSongHuntConfig(
            admin,
            e.id,
            e.config as SongHuntConfig,
            now,
            false,
            user.id,
          );
        } else if (e.type === "boss_fight") {
          config = await buildBossFightConfig(
            admin,
            e.id,
            e.config as BossFightConfig,
            user.id,
          );
        } else {
          config = e.config as Record<string, unknown>;
        }

        return {
          id: e.id,
          type: e.type,
          title: e.title,
          description: e.description,
          active: e.active,
          startsAt: e.starts_at,
          endsAt: e.ends_at,
          config,
        };
      }),
    );

    return jsonResponse({ events });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
