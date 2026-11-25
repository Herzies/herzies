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
 *
 * A finished duel is reported once (action "duel"): it lands in 00152's
 * record_duel, never touching health, and a replay of the same id adds
 * nothing.
 *
 * The Wilds (00154, wilds-loot.ts): a herzie taken down drops a random card
 * from its bag into escrow ("wildsDrop"), someone takes it ("wildsTake") or
 * it goes back ("wildsReturn"), a cache is opened once ("wildsCache", its
 * loot rolled here), and the report's `wilds` keeps everyone in a Wilds
 * room "on the Wilds" for the listening bonus. Each is idempotent on the
 * room's id, so a retry is safe.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  BOSS_LOOT_EXCLUDED_ITEM_IDS,
  filterDroppablePool,
  getHerzieStatsFromUnits,
  NON_DROPPABLE_ITEM_IDS,
  normalizeEquipped,
  normalizeUnits,
  pickWeightedDrop,
  type Rarity,
} from "../_shared/shared/items.ts";
import {
  isChestFloor,
  isTowerBoon,
  TOWER_DROP_CHANCE,
  TOWER_DROPS_DAILY_CAP,
  TOWER_XP_DAILY_CAP,
  towerBoonKey,
  towerChestRolls,
  towerLootLean,
  towerXpPerKill,
} from "../_shared/shared/tower.ts";
import { rollCacheLoot } from "../_shared/shared/wilds-loot.ts";
import { verifyVitalsRequest } from "../_shared/shared/town-net.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOWN_TICKET_SECRET = Deno.env.get("TOWN_TICKET_SECRET");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A room holds 40; a batch can't be bigger than a few rooms. */
const MAX_BATCH = 200;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

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

/** Marks the herzies a Wilds room reports as on the Wilds (00154's
 * wilds_presence, which ignores an event that isn't the one on now). Null
 * when there's nothing to mark; never throws. */
async function wildsPresence(
  db: SupabaseClient,
  wilds: { event: string; uids: string[] } | undefined,
): Promise<number | null> {
  if (!wilds || !isUuid(wilds.event)) return null;
  const uids = (Array.isArray(wilds.uids) ? wilds.uids : [])
    .slice(0, MAX_BATCH)
    .filter(isUuid);
  if (uids.length === 0) return null;
  try {
    return (await rpc(db, "wilds_presence", {
      p_event: wilds.event,
      p_uids: uids,
    })) as number;
  } catch {
    return null;
  }
}

/** Items picked as listening picks a drop — the droppable pool (less
 * `exclude`), by rarity, leaning on the herzie's Luck — one per entry of
 * `leans`, each leaning on its rarities by that much more (a Tower drop's
 * floor: towerLootLean). */
async function rollDrops(
  db: SupabaseClient,
  uid: string,
  leans: Record<Rarity, number>[],
  exclude: readonly string[] = [],
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
  const droppable = (pool ? filterDroppablePool(pool) : []).filter(
    (i) => !exclude.includes(i.id),
  );
  const { luck } = getHerzieStatsFromUnits(
    Array.isArray(unitRows) ? normalizeUnits(unitRows) : [],
  );
  const out: string[] = [];
  for (const lean of leans) {
    const picked = pickWeightedDrop(droppable, luck, Math.random, lean);
    if (picked) out.push(picked.id);
  }
  return out;
}

type RaidMessage = {
  lock?: { event: string; uids: string[]; at: number; hpPerPlayer: number };
  joins?: { event: string; uids: string[]; hpPerPlayer: number };
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
  /** Something failed: the report is retried. */
  failed: boolean;
  /** The lock or an out failed: damage, settle and a wipe must wait for
   * them (a herzie out before the killing blow isn't paid). */
  blocking: boolean;
  reply: {
    lock?: unknown;
    refused?: string[];
    out?: string[];
  } | null;
}> {
  const event = [msg.lock, msg.joins, msg.out, msg.revived, msg.wipe, msg.boss]
    .map((m) => m?.event)
    .find((e): e is string => typeof e === "string" && UUID.test(e));
  if (!event) return { failed: false, blocking: false, reply: null };
  let failed = false;
  let blocking = false;
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
      blocking = true;
    }
  }
  if (msg.joins && msg.joins.event === event) {
    // After the lock: herzies who walked in late join the roster and the
    // boss's health grows to fit them (00148). Blocking, like the lock:
    // their damage must not land before they're on it.
    try {
      const joined = await rpc(db, "join_boss_fight", {
        p_event: event,
        p_uids: uids(msg.joins.uids),
        p_per_player: Number.isFinite(msg.joins.hpPerPlayer)
          ? msg.joins.hpPerPlayer
          : null,
      });
      if (joined) reply.lock = joined;
    } catch {
      failed = true;
      blocking = true;
    }
  }
  if (msg.out && msg.out.event === event) {
    try {
      await rpc(db, "mark_boss_out", { p_event: event, p_uids: uids(msg.out.uids) });
    } catch {
      failed = true;
      blocking = true;
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
  return { failed, blocking, reply };
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
      /** Damage, the HP each healed or blocked (00111), minion damage
       * (00122), and the points a Taunt's hold earned (00142). */
      damage: {
        uid: string;
        damage: number;
        healing?: number;
        blocked?: number;
        adds?: number;
        taunt?: number;
      }[];
    };
    /** The raid (00122): the lock, revives, who's out, a wipe, the log. */
    lock?: { event: string; uids: string[]; at: number; hpPerPlayer: number };
    joins?: { event: string; uids: string[]; hpPerPlayer: number };
    revived?: { event: string; batch: string; rows: { uid: string; hp: number }[] };
    out?: { event: string; uids: string[] };
    wipe?: { event: string };
    log?: Record<string, unknown> & { event?: string };
    /** The fight is over: the cave's end screen, for these herzies. */
    results?: { event: string; uids: string[] };
    /** The Tower: a herzie's kills since the last batch, the best floor
     * cleared in it, a Warden's floor's chest opened, and the climb it
     * belongs to (the ticket's) with its boons and picks skipped so far
     * (TOWER_BOONS). */
    tower?: {
      event: string;
      batch: string;
      uid: string;
      kills: { floor: number; x: number; z: number }[];
      cleared?: number;
      chest?: { floor: number; x: number; z: number };
      climb?: number;
      boons?: unknown[];
      skips?: number;
    };
    /** action "eat": who ate what. */
    uid?: string;
    item?: string;
    /** action "revive": the health a Bard's resurrect brings `uid` back
     * with (outside a raid). */
    health?: unknown;
    /** action "duel": a finished duel (00152 record_duel). `id` is the
     * room's, unique per duel; the per-duelist maps are keyed by uid. */
    id?: unknown;
    a?: unknown;
    b?: unknown;
    winner?: unknown;
    why?: unknown;
    ms?: unknown;
    damage?: unknown;
    maxHp?: unknown;
    level?: unknown;
    credited?: unknown;
    /** The Wilds' loot (00154). `id`: the room's drop id ("wildsDrop",
     * "wildsTake") or a wildsCacheId ("wildsCache"). */
    event?: unknown;
    victim?: unknown;
    killer?: unknown;
    x?: unknown;
    z?: unknown;
    ids?: unknown;
    /** On a report: these herzies are on the Wilds (the listening bonus),
     * while `event` is the Wilds event on now. */
    wilds?: { event: string; uids: string[] };
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
  if (msg.action === "duel") {
    // A finished duel, reported once per end and safe to replay (the id).
    const duel = duelOf(msg);
    if (!duel) return jsonResponse({ error: "Bad duel" }, 400);
    try {
      const res = (await rpc(db, "record_duel", {
        p_id: duel.id,
        p_a: duel.a,
        p_b: duel.b,
        p_winner: duel.winner,
        p_why: duel.why,
        p_ms: duel.ms,
        p_damage: duel.damage,
        p_max_hp: duel.maxHp,
        p_level: duel.level,
        p_credited: duel.credited,
      })) as { recorded?: boolean; counted?: boolean } | null;
      return jsonResponse({
        ok: true,
        recorded: !!res?.recorded,
        counted: !!res?.counted,
      });
    } catch {
      return jsonResponse({ ok: false }, 500);
    }
  }
  if (msg.action === "wildsDrop") {
    // A herzie taken down on the Wilds: a random card from its bag into
    // escrow, where it fell. Null: nothing to drop, or the Wilds are shut.
    const x = Number(msg.x);
    const z = Number(msg.z);
    const killer = msg.killer ?? null;
    if (
      !isUuid(msg.id) || !isUuid(msg.event) || !isUuid(msg.victim) ||
      (killer !== null && !isUuid(killer)) ||
      !Number.isFinite(x) || !Number.isFinite(z)
    ) {
      return jsonResponse({ error: "Bad wildsDrop" }, 400);
    }
    try {
      const drop = await rpc(db, "wilds_drop", {
        p_id: msg.id,
        p_event: msg.event,
        p_victim: msg.victim,
        p_killer: killer,
        p_x: x,
        p_z: z,
      });
      return jsonResponse({ drop: drop ?? null });
    } catch {
      return jsonResponse({ error: "Failed to drop" }, 500);
    }
  }
  if (msg.action === "wildsTake") {
    // The room has judged reach and the killer's head start; this only
    // checks it's still there and fits the bag.
    if (!isUuid(msg.id) || !isUuid(msg.uid)) {
      return jsonResponse({ error: "Bad wildsTake" }, 400);
    }
    try {
      const res = (await rpc(db, "wilds_take", {
        p_id: msg.id,
        p_uid: msg.uid,
      })) as
        | { ok: true; item: string; level: number }
        | { ok: false; why: "bag-full" | "gone" };
      return jsonResponse(res);
    } catch {
      return jsonResponse({ error: "Failed to take" }, 500);
    }
  }
  if (msg.action === "wildsReturn") {
    // Unclaimed past their life: back to their owners.
    const ids = (Array.isArray(msg.ids) ? msg.ids : [])
      .slice(0, MAX_BATCH)
      .filter(isUuid);
    try {
      const returned = await rpc(db, "wilds_return", { p_ids: ids });
      return jsonResponse({
        returned: Array.isArray(returned) ? returned : [],
      });
    } catch {
      return jsonResponse({ error: "Failed to return" }, 500);
    }
  }
  if (msg.action === "wildsCache") {
    // First to open it: its loot, rolled here, lands on their ground. A
    // second opener (or a retry after it landed) gets nothing.
    if (
      typeof msg.id !== "string" || msg.id.length === 0 ||
      msg.id.length > 200 || !isUuid(msg.event) || !isUuid(msg.uid)
    ) {
      return jsonResponse({ error: "Bad wildsCache" }, 400);
    }
    try {
      const res = (await rpc(db, "wilds_open_cache", {
        p_id: msg.id,
        p_event: msg.event,
        p_uid: msg.uid,
        p_items: rollCacheLoot(Math.random),
      })) as { opened?: boolean; drops?: { id: string; item: string }[] } | null;
      return jsonResponse({
        opened: !!res?.opened,
        drops: Array.isArray(res?.drops) ? res.drops : [],
      });
    } catch {
      return jsonResponse({ error: "Failed to open" }, 500);
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
            [
              d.damage,
              d.healing ?? 0,
              d.blocked ?? 0,
              d.adds ?? 0,
              d.taunt ?? 0,
            ].every(Number.isFinite) &&
            (d.damage > 0 || (d.healing ?? 0) > 0 || (d.blocked ?? 0) > 0 ||
              (d.adds ?? 0) > 0 || (d.taunt ?? 0) > 0),
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
      // A failed lock or out holds the damage back: the room sends it all
      // again, and a herzie who left before the killing blow must be
      // marked out before that blow settles the fight. (A failed revive
      // is only retried: it never stops the fight's damage.)
      boss && bossDamage.length && !raid.blocking
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
      // On the Wilds for the next WILDS_PRESENCE_MS. Never fails the
      // report: the room says it again in half a minute.
      wildsPresence(db, msg.wilds),
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
    // listening rolls one, leaning rarer the higher the floor), under the
    // day's caps, once per batch; then a chest opened, once per floor per
    // Tower (00155), its items leaning rarer still and outside the cap.
    let tower = null as {
      drops: { id: string; item: string }[];
      chest?: { id: string; item: string }[];
    } | null;
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
      const chestFloor = isChestFloor(Number(tw.chest?.floor))
        ? Number(tw.chest?.floor)
        : 0;
      // The climb's floor, boons and skips move only for the climb still
      // running (00161): a batch from before a reset leaves them be. Boons
      // that aren't all known, or skips that aren't a count, are left out
      // (the old ones stay; 00162 holds them to the picks earned).
      const climb = Number.isInteger(tw.climb) && (tw.climb as number) >= 1
        ? tw.climb as number
        : null;
      const boons = Array.isArray(tw.boons) && tw.boons.length <= 100 &&
          tw.boons.every(isTowerBoon)
        ? tw.boons.map(towerBoonKey)
        : null;
      const skips = Number.isInteger(tw.skips) && (tw.skips as number) >= 0
        ? tw.skips as number
        : null;
      try {
        const xp = kills.reduce((n, k) => n + towerXpPerKill(k.floor), 0);
        const leans = kills
          .filter(() => Math.random() < TOWER_DROP_CHANCE)
          .map((k) => towerLootLean(k.floor));
        const items = leans.length > 0 ? await rollDrops(db, tw.uid, leans) : [];
        tower = (await rpc(db, "tower_grant", {
          p_user: tw.uid,
          p_event: tw.event,
          p_batch: tw.batch,
          p_xp: xp,
          p_cleared: cleared,
          p_item_ids: items,
          p_xp_cap: TOWER_XP_DAILY_CAP,
          p_drop_cap: TOWER_DROPS_DAILY_CAP,
          p_climb: climb,
          p_boons: boons,
          p_skips: skips,
        })) as typeof tower;
        if (chestFloor > 0 && tower) {
          // No Nostalgic Tokens, as a boss's loot.
          const inChest = await rollDrops(
            db,
            tw.uid,
            Array.from(
              { length: towerChestRolls(chestFloor) },
              () => towerLootLean(chestFloor, true),
            ),
            BOSS_LOOT_EXCLUDED_ITEM_IDS,
          );
          tower.chest = (await rpc(db, "tower_chest_grant", {
            p_user: tw.uid,
            p_event: tw.event,
            p_floor: chestFloor,
            p_item_ids: inChest,
          })) as { id: string; item: string }[];
        }
      } catch {
        towerFailed = true;
      }
    }
    // A failed HP write or boss batch is retried by the Town server, which
    // re-sends the same values (HP is absolute, a batch has an id), so ask
    // for that with an error status. Rest is additive and never retried.
    // A wipe after the damage: the last hits still count on the board.
    let wipeFailed = false;
    if (!raid.blocking && msg.wipe && UUID.test(msg.wipe.event)) {
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

const DUEL_REASONS: Record<string, true> = {
  defeat: true,
  yield: true,
  bounds: true,
  left: true,
  time: true,
  draw: true,
};

/** A duel report checked field by field, or null if it doesn't hold
 * together: two different duelists, a winner that's one of them (none only
 * for a draw), a known reason. The per-duelist numbers keep only the two
 * duelists' finite values. */
function duelOf(msg: {
  id?: unknown;
  a?: unknown;
  b?: unknown;
  winner?: unknown;
  why?: unknown;
  ms?: unknown;
  damage?: unknown;
  maxHp?: unknown;
  level?: unknown;
  credited?: unknown;
}): {
  id: string;
  a: string;
  b: string;
  winner: string | null;
  why: string;
  ms: number;
  damage: Record<string, number>;
  maxHp: Record<string, number>;
  level: Record<string, number>;
  credited: boolean;
} | null {
  const { id, a, b, why } = msg;
  const winner = msg.winner ?? null;
  const ms = Number(msg.ms);
  if (
    typeof id !== "string" || id.length === 0 || id.length > 200 ||
    typeof a !== "string" || !UUID.test(a) ||
    typeof b !== "string" || !UUID.test(b) || a === b ||
    typeof why !== "string" || !Object.hasOwn(DUEL_REASONS, why) ||
    !Number.isFinite(ms) || ms < 0 ||
    (winner === null) !== (why === "draw") ||
    (winner !== null && winner !== a && winner !== b)
  ) {
    return null;
  }
  const perDuelist = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (!v || typeof v !== "object") return out;
    for (const uid of [a, b]) {
      const n = Number((v as Record<string, unknown>)[uid]);
      if (Number.isFinite(n)) out[uid] = n;
    }
    return out;
  };
  return {
    id,
    a,
    b,
    winner: winner as string | null,
    why,
    ms: Math.min(Math.round(ms), 2_147_483_647),
    damage: perDuelist(msg.damage),
    maxHp: perDuelist(msg.maxHp),
    level: perDuelist(msg.level),
    credited: msg.credited === true && winner !== null,
  };
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
