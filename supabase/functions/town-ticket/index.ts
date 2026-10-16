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
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  getHerzieStatsFromUnits,
  normalizeEquipped,
  normalizeUnits,
  withStatPoints,
} from "../_shared/shared/items.ts";
import {
  signTownTicket,
  TOWN_TICKET_TTL_S,
} from "../_shared/shared/town-net.ts";
import { vitalsOf } from "../_shared/shared/vitals.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOWN_TICKET_SECRET = Deno.env.get("TOWN_TICKET_SECRET");
/** Where the Town server lives, so it can move without an app release. */
const TOWN_SERVER_URL = Deno.env.get("TOWN_SERVER_URL");
/** Never put on the statue: the owner's own herzie (music_lover69). */
const CHAMPION_SKIP = ["920a6cf8-3f1c-4274-b549-39d976ee6ee0"];

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

  const map = new URL(request.url).searchParams.get("map");
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
    .select("name, friend_code, stage, equipped, level, hp, hp_at, down, class, stat_stamina, stat_sonic, stat_euphony")
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

  // Health, and the combat stats the Town server rolls a cast's damage from.
  // Both come from the stored rows, never from anything the client sent.
  const now = Date.now();
  const vitals = vitalsOf(
    {
      hp: herzie.hp,
      hpAt: herzie.hp_at ? Date.parse(herzie.hp_at) : null,
      down: herzie.down,
    },
    herzie.level,
    herzie.stat_stamina ?? 0,
    now,
  );
  const { data: unitRows } = await admin.rpc("item_units_json", {
    p_user_id: user.id,
  });
  // Items plus stat points, as the sync bills them.
  const stats = withStatPoints(
    getHerzieStatsFromUnits(
      Array.isArray(unitRows) ? normalizeUnits(unitRows) : [],
    ),
    {
      stamina: herzie.stat_stamina,
      sonicPower: herzie.stat_sonic,
      euphony: herzie.stat_euphony,
    },
  );

  // Class skills and their levels: the Town server judges a skill's
  // strength from these, never from the client.
  let sk: [string, number][] | undefined;
  if (herzie.class) {
    const { data: skillRows } = await admin
      .from("herzie_skills")
      .select("skill_id, level")
      .eq("user_id", user.id);
    sk = (skillRows ?? []).map(
      (r: { skill_id: string; level: number }) =>
        [r.skill_id, r.level] as [string, number],
    );
  }

  // The boss room: only while the cave is open, and only on your feet.
  let boss:
    | { event: string; until: number; hp: number; maxHp: number }
    | undefined;
  if (map === "bossroom") {
    if (vitals.down) {
      return jsonResponse({ error: "Knocked out", reason: "down" }, 403);
    }
    if (Deno.env.get("BOSS_ROOM") === "off") {
      return jsonResponse(
        { error: "The cave is sealed", reason: "sealed" },
        403,
      );
    }
    const { data: open } = await admin.rpc("open_boss_json");
    if (!open) {
      return jsonResponse(
        { error: "The cave is sealed", reason: "sealed" },
        403,
      );
    }
    boss = open as typeof boss;
  }

  // The Tower: only while a Tower event is on, and only on your feet. Each
  // herzie has a room of their own there, named by their user id.
  let tower: { event: string; until: number; floor: number } | undefined;
  if (map === "tower") {
    if (vitals.down) {
      return jsonResponse({ error: "Knocked out", reason: "down" }, 403);
    }
    const { data: open } = await admin.rpc("open_tower_json", {
      p_user: user.id,
    });
    if (!open) {
      return jsonResponse(
        { error: "The Tower is closed", reason: "sealed" },
        403,
      );
    }
    tower = open as typeof tower;
  }

  const exp = Math.floor(now / 1000) + TOWN_TICKET_TTL_S;
  const ticket = await signTownTicket(
    {
      uid: user.id,
      name: herzie.name,
      look: { seed: herzie.friend_code, stage: herzie.stage, equipped },
      exp,
      hp: { hp: vitals.hp, maxHp: vitals.maxHp, down: vitals.down },
      st: [
        stats.sonicPower,
        stats.luck,
        stats.critChance,
        stats.critDamage,
        stats.stamina,
        stats.def,
        stats.euphony,
      ],
      boss,
      tower,
      lv: herzie.level,
      ...(herzie.class ? { cls: herzie.class as string, sk } : {}),
    },
    TOWN_TICKET_SECRET,
  );
  return jsonResponse({
    ticket,
    url: TOWN_SERVER_URL,
    exp,
    vitals,
    champion: await championOf(admin),
    ...(tower ? { instance: user.id } : {}),
  });
});

/**
 * Who the Town's statue shows: the top damage dealer of the last boss fight
 * that's over, with their look as others see it out walking (no ground
 * accessories). Null if there's none yet, or if looking fails: the statue
 * keeps its stand-in, and the ticket still goes out.
 */
async function championOf(
  admin: SupabaseClient,
): Promise<{
  name: string;
  look: { seed: string; stage: number; equipped: Record<string, unknown> };
} | null> {
  let data: unknown;
  try {
    const res = await admin.rpc("boss_champion_json", {
      p_skip: CHAMPION_SKIP,
    });
    if (res.error) return null;
    data = res.data;
  } catch {
    return null;
  }
  if (!data) return null;
  const c = data as {
    name: string;
    seed: string;
    stage: number;
    equipped: unknown;
  };
  const { ground_left: _l, ground_right: _r, ...equipped } = normalizeEquipped(
    c.equipped,
  );
  return { name: c.name, look: { seed: c.seed, stage: c.stage, equipped } };
}
