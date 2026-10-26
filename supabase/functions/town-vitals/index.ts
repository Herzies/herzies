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
 *
 * The room also asks here to use up a consumable a fighter eats (00113's
 * eat_item, without touching HP: the room heals the fighter itself and
 * reports it like a skill's heal).
 *
 * A raid (00122) reports its lock, the herzies a Bard brought back, who's
 * out, and a wipe. Those land first, in that order, so the boss's health is
 * sized before the first damage and a revive lands before the health that
 * follows it; every one is idempotent, so a retried report is safe.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  filterDroppablePool,
  getHerzieStatsFromUnits,
  NON_DROPPABLE_ITEM_IDS,
  normalizeEquipped,
  normalizeUnits,
  pickWeightedDrop,
} from "../_shared/shared/items.ts";
import {
  TOWER_DROP_CHANCE,
  TOWER_DROPS_DAILY_CAP,
  TOWER_XP_DAILY_CAP,
  towerXpPerKill,
} from "../_shared/shared/tower.ts";
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

/** `count` items picked as listening picks a drop: the droppable pool, by
 * rarity, leaning on the herzie's Luck. */
async function rollDrops(
  db: SupabaseClient,
  uid: string,
  count: number,
): Promise<string[]> {
  const [{ data: pool }, { data: unitRows }] = await Promise.all([
    db
      .from("items")
      .select("id, rarity")
      .not(
        "id",
        "in",
        `(${NON_DROPPABLE_ITEM_IDS.map((id) => `"${id}"`).join(",")})`,
      ),
    db.rpc("item_units_json", { p_user_id: uid }),
  ]);
  const droppable = pool ? filterDroppablePool(pool) : [];
  const { luck } = getHerzieStatsFromUnits(
    Array.isArray(unitRows) ? normalizeUnits(unitRows) : [],
  );
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const picked = pickWeightedDrop(droppable, luck);
    if (picked) out.push(picked.id);
  }
  return out;
}

type RaidMessage = {
  lock?: { event: string; uids: string[]; at: number; hpPerPlayer: number };
  revived?: { event: string; batch: string; rows: { uid: string; hp: number }[] };
  out?: { event: string; uids: string[] };
  wipe?: { event: string };
  boss?: { event: string };
};

/** The raid's lock, outs and revives (00122), in that order, and the
 * database's word back: its lock, refused revives, everyone out. */
async function applyRaid(
  db: SupabaseClient,
  msg: RaidMessage,
): Promise<{
  failed: boolean;
  reply: {
    lock?: unknown;
    refused?: string[];
    out?: string[];
  } | null;
}> {
  const event = [msg.lock, msg.out, msg.revived, msg.wipe, msg.boss]
    .map((m) => m?.event)
    .find((e): e is string => typeof e === "string" && UUID.test(e));
  if (!event) return { failed: false, reply: null };
  let failed = false;
  const reply: { lock?: unknown; refused?: string[]; out?: string[] } = {};
  const uids = (list: unknown) =>
    (Array.isArray(list) ? list : [])
      .slice(0, MAX_BATCH)
      .filter((u): u is string => typeof u === "string" && UUID.test(u));
  if (msg.lock && msg.lock.event === event) {
    try {
      reply.lock = await rpc(db, "lock_boss_fight", {
        p_event: event,
        p_uids: uids(msg.lock.uids),
        p_per_player: Number.isFinite(msg.lock.hpPerPlayer)
          ? msg.lock.hpPerPlayer
          : null,
        p_at: Number.isFinite(msg.lock.at) ? Math.round(msg.lock.at) : null,
      });
    } catch {
      failed = true;
    }
  }
  if (msg.out && msg.out.event === event) {
    try {
      await rpc(db, "mark_boss_out", { p_event: event, p_uids: uids(msg.out.uids) });
    } catch {
      failed = true;
    }
  }
  const rez = msg.revived;
  if (
    rez && rez.event === event && typeof rez.batch === "string" &&
    rez.batch.length <= 200
  ) {
    const rows = (Array.isArray(rez.rows) ? rez.rows : [])
      .slice(0, MAX_BATCH)
      .filter((r) => UUID.test(r?.uid ?? "") && Number.isFinite(r.hp) && r.hp > 0);
    try {
      const res = (await rpc(db, "apply_boss_revive_batch", {
        p_batch: rez.batch,
        p_event: event,
        p_rows: rows,
      })) as { refused?: string[] } | null;
      reply.refused = uids(res?.refused);
    } catch {
      failed = true;
    }
  }
  try {
    reply.out = uids(await rpc(db, "boss_out_json", { p_event: event }));
  } catch {
    // Only news: the room learns it on the next report.
  }
  return { failed, reply };
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
    hp?: { uid: string; hp: number; heal?: number }[];
    rest?: { uid: string; bonus: number }[];
    skills?: {
      batch: string;
      xp: { uid: string; skill: string; xp: number }[];
    };
    boss?: {
      event: string;
      batch: string;
      /** Damage, the HP each healed or blocked (00111), and minion
       * damage (00122). */
      damage: {
        uid: string;
        damage: number;
        healing?: number;
        blocked?: number;
        adds?: number;
      }[];
    };
    /** The raid (00122): the lock, revives, who's out, a wipe, the log. */
    lock?: { event: string; uids: string[]; at: number; hpPerPlayer: number };
    revived?: { event: string; batch: string; rows: { uid: string; hp: number }[] };
    out?: { event: string; uids: string[] };
    wipe?: { event: string };
    log?: Record<string, unknown> & { event?: string };
    /** The fight is over: the cave's end screen, for these herzies. */
    results?: { event: string; uids: string[] };
    /** The Tower: a herzie's kills since the last batch, and the best
     * floor cleared in it. */
    tower?: {
      event: string;
      batch: string;
      uid: string;
      kills: { floor: number; x: number; z: number }[];
      cleared?: number;
    };
    /** action "eat": who ate what. */
    uid?: string;
    item?: string;
    /** action "revive": the health a Bard's resurrect brings `uid` back
     * with (outside a raid). */
    health?: unknown;
  };
  try {
    msg = JSON.parse(body);
  } catch {
    return jsonResponse({ error: "Bad JSON" }, 400);
  }
  const db = admin();
  if (msg.action === "eat") {
    // Use one up; the room heals. Never retried, so it can't eat twice.
    if (!UUID.test(msg.uid ?? "") || typeof msg.item !== "string") {
      return jsonResponse({ error: "Bad eat" }, 400);
    }
    try {
      const res = (await rpc(db, "eat_item", {
        p_user_id: msg.uid,
        p_item_id: msg.item,
        p_apply_hp: false,
      })) as { ok: boolean; heal?: number; reason?: string } | null;
      return jsonResponse({
        ok: !!res?.ok,
        heal: res?.heal ?? 0,
        reason: res?.reason ?? null,
      });
    } catch {
      return jsonResponse({ ok: false, reason: "failed" }, 500);
    }
  }
  if (msg.action === "revive") {
    // A Bard's resurrect outside a raid: only a herzie that's down comes
    // back (null otherwise).
    const health = Number(msg.health);
    if (!UUID.test(msg.uid ?? "") || !Number.isFinite(health)) {
      return jsonResponse({ error: "Bad revive" }, 400);
    }
    try {
      const vitals = await rpc(db, "revive_herzie", {
        p_user: msg.uid,
        p_hp: health,
      });
      return jsonResponse({ ok: !!vitals, vitals: vitals ?? null });
    } catch {
      return jsonResponse({ ok: false }, 500);
    }
  }
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
          (d) =>
            UUID.test(d.uid) &&
            [d.damage, d.healing ?? 0, d.blocked ?? 0, d.adds ?? 0].every(
              Number.isFinite,
            ) &&
            (d.damage > 0 || (d.healing ?? 0) > 0 || (d.blocked ?? 0) > 0 ||
              (d.adds ?? 0) > 0),
        )
        : [];
    // The raid first: the lock (so the boss's health is sized before any
    // damage), who's out (before damage, so a herzie out before the kill
    // isn't paid), and revives (before the health that follows them).
    const raid = await applyRaid(db, msg);
    const skills = msg.skills;
    const skillXp =
      skills && typeof skills.batch === "string"
        ? (skills.xp ?? []).slice(0, MAX_BATCH).filter(
          (x) =>
            UUID.test(x.uid) &&
            typeof x.skill === "string" &&
            Number.isFinite(x.xp) &&
            x.xp > 0,
        )
        : [];
    const [h, r, b, s] = await Promise.all([
      each(
        hp,
        // `heal`: how far skills may have raised it since the last report
        // (00107); without it the write only ever lowers.
        (r) =>
          rpc(db, "set_herzie_hp", {
            p_user: r.uid,
            p_hp: r.hp,
            p_heal: Number.isFinite(r.heal) && (r.heal as number) > 0
              ? r.heal
              : 0,
          }),
      ),
      each(
        rest,
        (r) => rpc(db, "rest_herzie", { p_user: r.uid, p_bonus: r.bonus }),
      ),
      // A failed lock, out or revive holds the damage back: the room sends
      // it all again, and a herzie who left before the killing blow must
      // be marked out before that blow settles the fight.
      boss && bossDamage.length && !raid.failed
        ? rpc(db, "apply_boss_damage_batch", {
          p_batch: boss.batch,
          p_event: boss.event,
          p_damage: bossDamage,
        }).then((res) => ({ ok: true, res }), () => ({ ok: false, res: null }))
        : Promise.resolve(null),
      skills && skillXp.length
        ? rpc(db, "apply_skill_xp_batch", {
          p_batch: skills.batch,
          p_xp: skillXp,
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
    // The Tower: pay the kills (a little XP, now and then an item, rolled as
    // listening rolls one), under the day's caps, once per batch.
    let tower: { drops: { id: string; item: string }[] } | null = null;
    let towerFailed = false;
    const tw = msg.tower;
    if (
      tw && UUID.test(tw.event) && UUID.test(tw.uid) &&
      typeof tw.batch === "string"
    ) {
      const kills = (Array.isArray(tw.kills) ? tw.kills : [])
        .slice(0, MAX_BATCH)
        .filter((k) => Number.isFinite(k.floor) && k.floor >= 1);
      const cleared = Number.isFinite(tw.cleared) ? Math.floor(tw.cleared as number) : 0;
      try {
        const xp = kills.reduce((n, k) => n + towerXpPerKill(k.floor), 0);
        const rolls = kills.filter(() => Math.random() < TOWER_DROP_CHANCE).length;
        const items = rolls > 0 ? await rollDrops(db, tw.uid, rolls) : [];
        tower = (await rpc(db, "tower_grant", {
          p_user: tw.uid,
          p_event: tw.event,
          p_batch: tw.batch,
          p_xp: xp,
          p_cleared: cleared,
          p_item_ids: items,
          p_xp_cap: TOWER_XP_DAILY_CAP,
          p_drop_cap: TOWER_DROPS_DAILY_CAP,
        })) as typeof tower;
      } catch {
        towerFailed = true;
      }
    }
    // A failed HP write or boss batch is retried by the Town server, which
    // re-sends the same values (HP is absolute, a batch has an id), so ask
    // for that with an error status. Rest is additive and never retried.
    // A wipe after the damage: the last hits still count on the board.
    let wipeFailed = false;
    if (!raid.failed && msg.wipe && UUID.test(msg.wipe.event)) {
      try {
        await rpc(db, "wipe_boss_fight", { p_event: msg.wipe.event });
      } catch {
        wipeFailed = true;
      }
    }
    const failed = h.failed > 0 || (b !== null && !b.ok) ||
      (s !== null && !s.ok) || towerFailed || raid.failed || wipeFailed;
    // The fight is over: who placed where (00110). Only once this report's
    // damage has landed, so the last hits count; and a failed lookup never
    // fails the report (the room would re-send it for nothing).
    // How the fight went, once (a retry finds it there and adds nothing).
    if (!failed && msg.log && UUID.test(String(msg.log.event ?? ""))) {
      try {
        await rpc(db, "log_boss_fight", {
          p_event: msg.log.event,
          p_log: msg.log,
        });
      } catch {
        // Only for tuning: never worth failing a report over.
      }
    }
    let results: unknown = null;
    const want = msg.results;
    if (!failed && want && UUID.test(want.event)) {
      const uids = (Array.isArray(want.uids) ? want.uids : [])
        .slice(0, MAX_BATCH)
        .filter((u) => typeof u === "string" && UUID.test(u));
      try {
        results = podiumLooks(
          await rpc(db, "boss_results_json", {
            p_event: want.event,
            p_uids: uids,
          }),
        );
      } catch {
        results = null;
      }
    }
    return jsonResponse(
      {
        hp: h,
        rest: r,
        boss: b?.res ? { ...(b.res as object), loot } : null,
        // Where each reported skill stands now, so the room can use (and
        // announce) a level-up at once.
        skills: s?.res ?? null,
        results,
        tower,
        raid: raid.reply,
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

/** The end screen's top three come with their looks, as the database has
 * them: made into looks as others see them out walking (no ground
 * accessories), like the statue's in town-ticket. */
function podiumLooks(table: unknown): unknown {
  const t = table as { top?: Record<string, unknown>[] } | null;
  if (!t?.top) return table;
  return {
    ...t,
    top: t.top.map(({ seed, stage, equipped, ...place }) => {
      const { ground_left: _l, ground_right: _r, ...worn } = normalizeEquipped(
        equipped,
      );
      return typeof seed === "string"
        ? { ...place, look: { seed, stage: Number(stage) || 1, equipped: worn } }
        : place;
    }),
  };
}
