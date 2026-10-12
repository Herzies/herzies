/**
 * `town-vitals` Edge Function: where herzie health is written.
 *
 * Two callers, two ways in:
 *  - The Town server (a Cloudflare Durable Object with no database access)
 *    reports what happened in a room: HP for the players in a fight, bench
 *    rest. Its requests carry an HMAC over the body, a timestamp and a nonce
 *    (see `signVitalsRequest`); the secret is the one that signs tickets.
 *  - A player's own app asks to respawn after being knocked out, with its
 *    JWT. That is the only thing a client may do here.
 *
 * Everything lands in the RPCs of 00101, which only ever lower HP (a report)
 * or add a capped bonus (rest) or restore half (respawn from down).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { verifyVitalsRequest } from "../_shared/shared/town-net.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOWN_TICKET_SECRET = Deno.env.get("TOWN_TICKET_SECRET");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A room holds 40; a batch can't be bigger than a few rooms. */
const MAX_BATCH = 200;

function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Run `fn` per item; one failure never sinks the rest of the batch. */
async function each<T>(
  items: T[],
  fn: (item: T) => Promise<unknown>,
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  await Promise.all(
    items.map(async (item) => {
      try {
        await fn(item);
        ok++;
      } catch {
        failed++;
      }
    }),
  );
  return { ok, failed };
}

async function rpc(
  db: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

async function handleRoom(request: Request, body: string): Promise<Response> {
  const ts = Number(request.headers.get("x-vitals-ts"));
  const nonce = request.headers.get("x-vitals-nonce") ?? "";
  const sig = request.headers.get("x-vitals-sig") ?? "";
  if (
    !TOWN_TICKET_SECRET ||
    !(await verifyVitalsRequest(body, ts, nonce, sig, TOWN_TICKET_SECRET))
  ) {
    return jsonResponse({ error: "Bad signature" }, 401);
  }
  let msg: {
    action?: string;
    hp?: { uid: string; hp: number }[];
    rest?: { uid: string; bonus: number }[];
    boss?: {
      event: string;
      batch: string;
      damage: { uid: string; damage: number }[];
    };
  };
  try {
    msg = JSON.parse(body);
  } catch {
    return jsonResponse({ error: "Bad JSON" }, 400);
  }
  const db = admin();
  if (msg.action === "report") {
    const hp = (msg.hp ?? []).slice(0, MAX_BATCH).filter(
      (r) => UUID.test(r.uid) && Number.isFinite(r.hp),
    );
    const rest = (msg.rest ?? []).slice(0, MAX_BATCH).filter(
      (r) => UUID.test(r.uid) && Number.isFinite(r.bonus) && r.bonus > 0,
    );
    const boss = msg.boss;
    const bossDamage =
      boss && UUID.test(boss.event) && typeof boss.batch === "string"
        ? (boss.damage ?? []).slice(0, MAX_BATCH).filter(
          (d) => UUID.test(d.uid) && Number.isFinite(d.damage) && d.damage > 0,
        )
        : [];
    const [h, r, b] = await Promise.all([
      each(
        hp,
        (r) => rpc(db, "set_herzie_hp", { p_user: r.uid, p_hp: r.hp }),
      ),
      each(
        rest,
        (r) => rpc(db, "rest_herzie", { p_user: r.uid, p_bonus: r.bonus }),
      ),
      boss && bossDamage.length
        ? rpc(db, "apply_boss_damage_batch", {
          p_batch: boss.batch,
          p_event: boss.event,
          p_damage: bossDamage,
        }).then((res) => ({ ok: true, res }), () => ({ ok: false, res: null }))
        : Promise.resolve(null),
    ]);
    // The boss fell: put the rewards on the ground now rather than on the
    // next minute's cron (still the backstop; settling twice pays once), and
    // say which drops are whose so the cave can drop them to be picked up
    // (00105). A retried batch that finds the boss already dead lands here
    // too, so a lost reply still gets its loot.
    let loot: Record<string, { id: string; item: string }[]> | null = null;
    if (b?.ok && boss && (b.res as { killed?: boolean } | null)?.killed) {
      try {
        await rpc(db, "settle_boss_fight", { p_event_id: boss.event });
        loot = await rpc(db, "boss_loot_json", { p_event: boss.event });
      } catch {
        // The cron settles it within a minute; the cave just drops nothing,
        // and the loot waits on everyone's Home ground.
      }
    }
    // A failed HP write or boss batch is retried by the Town server, which
    // re-sends the same values (HP is absolute, a batch has an id), so ask
    // for that with an error status. Rest is additive and never retried.
    const failed = h.failed > 0 || (b !== null && !b.ok);
    return jsonResponse(
      {
        hp: h,
        rest: r,
        boss: b?.res ? { ...(b.res as object), loot } : null,
      },
      failed ? 502 : 200,
    );
  }
  return jsonResponse({ error: "Unknown action" }, 400);
}

async function handlePlayer(request: Request, body: string): Promise<Response> {
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
  let msg: { action?: string };
  try {
    msg = JSON.parse(body || "{}");
  } catch {
    return jsonResponse({ error: "Bad JSON" }, 400);
  }
  const db = admin();
  if (msg.action === "respawn") {
    try {
      const vitals = await rpc(db, "respawn_herzie", { p_user: user.id });
      if (!vitals) return jsonResponse({ error: "No herzie" }, 404);
      return jsonResponse({ vitals });
    } catch {
      return jsonResponse({ error: "Failed to respawn" }, 500);
    }
  }
  if (msg.action === "vitals") {
    try {
      const vitals = await rpc(db, "herzie_vitals", { p_user: user.id });
      if (!vitals) return jsonResponse({ error: "No herzie" }, 404);
      return jsonResponse({ vitals });
    } catch {
      return jsonResponse({ error: "Failed to load vitals" }, 500);
    }
  }
  return jsonResponse({ error: "Unknown action" }, 400);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  const body = await request.text();
  if (body.length > 64 * 1024) {
    return jsonResponse({ error: "Too large" }, 413);
  }
  // The Town server signs; a player's app carries its JWT.
  return request.headers.has("x-vitals-sig")
    ? await handleRoom(request, body)
    : await handlePlayer(request, body);
});
