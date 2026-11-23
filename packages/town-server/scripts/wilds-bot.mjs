#!/usr/bin/env node
/**
 * A rival on the Wilds, to try the free-for-all and its loot against: one
 * herzie (a real local user, Rival A by default) that leaves the safe camp
 * and wanders the island. Anyone out of the camp within SIGHT it goes
 * after: to its class's standoff, casting at them (missing some, so it can
 * be beaten) and using its skills; hit, it fights back. Taken down, it does
 * what the app does: lies where it fell till the room gets it up in the
 * camp, then sets off again. It leaves the cards on the ground alone (yours
 * included, so you can see them lie there), unless BOT_LOOT=1.
 *
 *   node scripts/wilds-bot.mjs           (or: scripts/local.sh wilds-bot)
 *
 * Needs the local stack (`scripts/local.sh up`) and a Wilds event on
 * (`scripts/local.sh wilds`); it reads the event and its herzie from the
 * local database (Docker) itself. Its bag is topped up with a few ordinary
 * cards whenever it holds fewer than BOT_CARDS it could drop, so every
 * takedown drops something.
 *
 * Env:
 *   TOWN_URL            default ws://127.0.0.1:8797 (local.sh's Town)
 *   TOWN_TICKET_SECRET  default: packages/town-server/.dev.vars'
 *   SHARD               default 0 (where the app lands first)
 *   BOT_UID             the local user it plays (default Rival A's)
 *   BOT_NAME            default: that herzie's name
 *   BOT_CLASS           bard | record_slinger | percussionist (default: its herzie's)
 *   BOT_LEVEL           default: BOT_MATCH_EMAIL's herzie's level, else 25
 *   BOT_MATCH_EMAIL     default dev@herzies.local
 *   BOT_ACCURACY        0–1, the share of casts aimed true (default 0.55)
 *   BOT_LOOT            1: take the cards it may (default: leave them)
 *   BOT_CARDS           droppable cards it keeps at least (default 6)
 *   DB_CONTAINER        default supabase_db_herzies
 *
 * Like duel-bot.mjs it speaks the real protocol with a ticket it signs
 * itself (the Wilds claim the town-ticket function would add included), so
 * the room judges its casts, takedowns and drops like anyone's.
 */
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { BOSS_ONLY_ITEM_IDS, ITEMS, NON_DROPPABLE_ITEM_IDS } from "@herzies/shared/items";
import { DISC_RANGE, WAVE_RANGE } from "@herzies/shared/combat";
import { SKILL_DEFS } from "@herzies/shared/skills";
import {
  decodeSnapshot,
  encodeCastFrame,
  encodeStateFrame,
  signTownTicket,
  TOWN_CLOSE,
  TOWN_FLAG_COMBAT,
  TOWN_MAPS,
  TOWN_PROTOCOL,
  TOWN_TICK_MS,
  TOWN_WALK_SPEED,
  withCastSeq,
} from "@herzies/shared/town-net";
import { inWildsSafeCamp, WILDS_SAFE_CAMP } from "@herzies/shared/wilds";
import { WILDS_CACHE_SPOTS, WILDS_DROP } from "@herzies/shared/wilds-loot";
import { classOr, herzieKit } from "./bot-herzie.mjs";

const DB = process.env.DB_CONTAINER ?? "supabase_db_herzies";
const url = process.env.TOWN_URL ?? "ws://127.0.0.1:8797";
const secret =
  process.env.TOWN_TICKET_SECRET ??
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^TOWN_TICKET_SECRET=(.*)$/m)?.[1];
const shard = process.env.SHARD ?? "0";
const uid = process.env.BOT_UID ?? "660531c8-54d2-4355-b26c-2b0f415ddce3";
const accuracy = Math.max(0, Math.min(1, Number(process.env.BOT_ACCURACY ?? 0.55)));
const loots = process.env.BOT_LOOT === "1";
const minCards = Number(process.env.BOT_CARDS ?? 6);
if (!/^[0-9a-f-]{36}$/i.test(uid)) throw new Error(`BOT_UID isn't a uuid: ${uid}`);
if (!secret) throw new Error("no TOWN_TICKET_SECRET (env or packages/town-server/.dev.vars)");

/** Someone out of the camp this close is gone after; one this far off (or
 * back in the camp, or down) is let go. */
const SIGHT = 25;
const GIVE_UP = 38;
/** Hit by someone: they're the one to go after for this long. */
const GRUDGE_MS = 10_000;
/** Up in the camp: a moment to look about before setting off. */
const GET_UP_PAUSE_MS = 2_500;
/** Kept this far inside the island's edge. */
const EDGE = TOWN_MAPS.wilds.radius - 6;

// --- The local database ---------------------------------------------------------

const psqlArgs = (q) => ["exec", "-i", DB, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", q];
const sql = (q) => execFileSync("docker", psqlArgs(q), { encoding: "utf8" }).trim();
const sqlAsync = async (q) => (await promisify(execFile)("docker", psqlArgs(q))).stdout.trim();
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;

/** The Wilds claim a ticket for the Wilds carries now (town-ticket's
 * open_wilds_json): null with no event on (no drops, no caches). */
function wildsClaim() {
  const raw = sql("select public.open_wilds_json()");
  return raw ? JSON.parse(raw) : null;
}

const herzieRow = sql(
  `select name, friend_code, stage, coalesce(class, '') from public.herzies where user_id = ${lit(uid)}`,
);
if (!herzieRow) throw new Error(`no local herzie for ${uid}`);
const [dbName, friendCode, dbStage, dbClass] = herzieRow.split("|");
const name = process.env.BOT_NAME ?? dbName;
const cls = classOr(process.env.BOT_CLASS, classOr(dbClass, "bard"));
const matchEmail = process.env.BOT_MATCH_EMAIL ?? "dev@herzies.local";
const level = Number(
  process.env.BOT_LEVEL ??
    (sql(
      `select h.level from public.herzies h join auth.users u on u.id = h.user_id where u.email = ${lit(matchEmail)}`,
    ) ||
      25),
);

/** Ordinary cards to top its bag up with: common and uncommon, anyone's to
 * wear or keep, that drop the usual way (and that the database has). */
const ORDINARY = (() => {
  const never = new Set([...NON_DROPPABLE_ITEM_IDS, ...BOSS_ONLY_ITEM_IDS]);
  const ids = Object.values(ITEMS)
    .filter((i) => (i.rarity === "common" || i.rarity === "uncommon") && !i.requiredClass && !never.has(i.id))
    .map((i) => i.id);
  const known = sql(`select id from public.items where id in (${ids.map(lit).join(", ")})`);
  return known ? known.split("\n") : [];
})();

/** Fewer than `minCards` cards it could drop (not worn, not held by a
 * loadout): a few ordinary ones more. */
async function topUp() {
  const have = Number(
    await sqlAsync(
      `select count(*) from public.item_units u where u.user_id = ${lit(uid)} and u.equipped_slot is null
         and not exists (select 1 from public.loadout_items li where li.unit_id = u.id)`,
    ),
  );
  if (have >= minCards || ORDINARY.length === 0) return;
  const given = [];
  for (let n = have; n < minCards + 2; n++) {
    const item = ORDINARY[Math.floor(Math.random() * ORDINARY.length)];
    await sqlAsync(`select public.grant_inventory_item(${lit(uid)}, ${lit(item)}, 1)`);
    given.push(item);
  }
  log(`bag had ${have} droppable cards; gave it ${given.join(", ")}`);
}

// --- The herzie -----------------------------------------------------------------

async function ticket() {
  const { gear, ...kit } = herzieKit(cls, level);
  const wilds = wildsClaim();
  return {
    wilds,
    ticket: await signTownTicket(
      {
        uid,
        name,
        look: { seed: friendCode, stage: Number(dbStage) || 3, equipped: gear },
        exp: Math.floor(Date.now() / 1000) + 600,
        ...kit,
        em: ["wave", "cheer"],
        ...(wilds ? { wilds } : {}),
      },
      secret,
    ),
  };
}

const MELEE = cls === "percussionist";
/** How far it likes to stand from its foe: in reach of its stick, or well
 * inside its cast's range but far enough to make you aim. */
const KEEP = MELEE ? 1.1 : 7;
const RANGE = MELEE ? 1.9 : (cls === "record_slinger" ? DISC_RANGE : WAVE_RANGE) - 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fmt = (n) => n.toFixed(1);

function run() {
  const spawn = TOWN_MAPS.wilds.spawn;
  const me = { x: spawn.x, z: spawn.z, heading: Math.PI / 2, speed: 0 };
  /** Everyone else: latest position, name, and PvP standing (hp, maxHp,
   * down/shield as server ms), by entity id. */
  const seen = new Map();
  const names = new Map();
  const standing = new Map();
  /** The cards on the ground, by drop id (as the room tells them). */
  const drops = new Map();
  let you = -1;
  let myHp = 1;
  let down = false;
  let stunnedUntil = 0;
  let restUntil = 0;
  let target = -1;
  let grudge = { id: -1, until: 0 };
  let waypoint = null;
  let pauseUntil = 0;
  let casts = 0;
  let castSeq = 0;
  let stateSeq = 0;
  let skillSeq = 0;
  let nextCastAt = 0;
  let takeAt = 0;
  let strafe = 1;
  const readyAt = new Map();
  /** Server clock minus ours, from snapshots. */
  let clockOffset = 0;
  const serverNow = () => Date.now() + clockOffset;
  const who = (id) => (id === you ? name : (names.get(id) ?? `#${id}`));
  let loop;
  let renew;

  const ws = new WebSocket(`${url}/v1/town/wilds?shard=${shard}`);
  ws.binaryType = "arraybuffer";
  const json = (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

  ws.onopen = async () => {
    const t = await ticket();
    if (!t.wilds) log("no Wilds event on: fights, but no drops (scripts/local.sh wilds)");
    json({
      t: "hello",
      v: TOWN_PROTOCOL,
      ticket: t.ticket,
      at: { x: me.x, z: me.z, heading: me.heading, speed: 0, flags: 0 },
    });
  };

  /** Whether entity `id` may be gone after now: seen, up, out of the camp
   * and (unless it started it) no longer protected. */
  function fair(id, now) {
    const p = seen.get(id);
    const s = standing.get(id);
    if (!p || inWildsSafeCamp(p.x, p.z) || s?.down) return false;
    return !(s?.shield > serverNow()) || grudge.id === id;
  }

  /** Who to go after: whoever hit it last (for a while), else the one it
   * has, else the nearest fair one in sight. */
  function foe(now) {
    const dist = (id) => Math.hypot(seen.get(id).x - me.x, seen.get(id).z - me.z);
    let next = -1;
    if (grudge.until > now && fair(grudge.id, now) && dist(grudge.id) <= GIVE_UP) next = grudge.id;
    else if (target !== -1 && fair(target, now) && dist(target) <= GIVE_UP) next = target;
    else {
      let best = SIGHT;
      for (const id of seen.keys())
        if (id !== you && fair(id, now) && dist(id) < best) {
          best = dist(id);
          next = id;
        }
    }
    if (next !== target) {
      if (next !== -1) log(`after "${who(next)}" (${fmt(dist(next))} m off)`);
      else if (target !== -1) log(`letting "${who(target)}" go`);
      target = next;
      readyAt.clear();
    }
    return next === -1 ? null : seen.get(next);
  }

  /** Walk by (vx, vz) (a direction, any length) at `speed`, not into the
   * camp while fighting and not off the island. */
  function step(vx, vz, speed, dt, keepOut) {
    if (keepOut) {
      const cx = me.x - WILDS_SAFE_CAMP.x;
      const cz = me.z - WILDS_SAFE_CAMP.z;
      const r = Math.hypot(cx, cz) || 0.01;
      if (r < WILDS_SAFE_CAMP.r + 2.5) {
        vx += (cx / r) * 1.5;
        vz += (cz / r) * 1.5;
      }
    }
    const r = Math.hypot(me.x, me.z);
    if (r > EDGE) {
      vx -= (me.x / r) * 1.5;
      vz -= (me.z / r) * 1.5;
    }
    const v = Math.hypot(vx, vz);
    if (v < 0.05) return;
    me.x += (vx / v) * speed * dt;
    me.z += (vz / v) * speed * dt;
    me.heading = Math.atan2(vx, vz);
    me.speed = speed;
  }

  function aimAt(p, miss) {
    const dx = p.x - me.x;
    const dz = p.z - me.z;
    const d = Math.hypot(dx, dz);
    let yaw = Math.atan2(dx, dz);
    if (miss) yaw += (Math.random() < 0.5 ? -1 : 1) * (0.14 + Math.random() * 0.16);
    return { yaw, pitch: MELEE ? 0 : Math.atan2(1 - 1.2, Math.max(0.5, d)), d };
  }

  function useSkill(skill, yaw, pitch) {
    const now = Date.now();
    if ((readyAt.get(skill) ?? 0) > now) return false;
    readyAt.set(skill, now + SKILL_DEFS[skill].cooldownMs + 250);
    json({ t: "skill", skill, seq: ++skillSeq, yaw, pitch });
    return true;
  }

  /** One step of a fight: close to KEEP and circle there, then maybe cast
   * (never from the camp: nothing it sends from there hurts). */
  function fight(p, dt, now) {
    const dx = me.x - p.x;
    const dz = me.z - p.z;
    const d = Math.hypot(dx, dz) || 0.01;
    if (Math.random() < 0.01) strafe = -strafe;
    const pull = Math.max(-1, Math.min(1, (KEEP - d) / 2));
    const side = d < KEEP + 3 ? (MELEE ? 0.35 : 0.6) : 0;
    step(
      (-dz / d) * strafe * side + (dx / d) * pull,
      (dx / d) * strafe * side + (dz / d) * pull,
      TOWN_WALK_SPEED * (d > KEEP + 3 ? 0.95 : 0.8),
      dt,
      true,
    );
    const { yaw, pitch, d: dist } = aimAt(p, false);
    me.heading = yaw;
    if (now < nextCastAt || dist > RANGE || inWildsSafeCamp(me.x, me.z)) return;
    nextCastAt = now + 470 + Math.random() * 180;
    if (cls === "bard" && myHp < 0.55 && useSkill("soothing-drones", yaw, pitch)) return;
    if (cls === "bard" && useSkill("haste", yaw, pitch)) return;
    if (cls === "record_slinger" && dist < 14 && Math.random() < 0.3 && useSkill("backspin", yaw, pitch)) return;
    if (cls === "record_slinger" && useSkill("shuffle", yaw, pitch)) return;
    if (cls === "percussionist" && dist < 3 && useSkill("rimshot", yaw, pitch)) return;
    if (cls === "percussionist" && myHp < 0.5 && useSkill("cymbrella", yaw, pitch)) return;
    const shot = aimAt(p, Math.random() >= accuracy);
    casts++;
    ws.send(encodeCastFrame({ seq: (castSeq = (castSeq + 1) & 0xffff), yaw: shot.yaw, pitch: shot.pitch }));
  }

  /** With BOT_LOOT: the nearest card it may take, within SIGHT. */
  function cardToTake() {
    if (!loots) return null;
    let best = null;
    let reach = SIGHT;
    for (const c of drops.values()) {
      const mine = c.firstFor === null || c.firstFor === you || serverNow() >= c.firstUntil;
      const d = Math.hypot(c.x - me.x, c.z - me.z);
      if (mine && d < reach) {
        reach = d;
        best = c;
      }
    }
    return best;
  }

  /** Out of a fight: from spot to spot round the island (where caches
   * turn up: open ground, all out of the camp), a breather at each. */
  function wander(dt, now) {
    if (now < pauseUntil) return;
    if (!waypoint) {
      const spots = WILDS_CACHE_SPOTS.filter((s) => Math.hypot(s.x - me.x, s.z - me.z) > 10);
      waypoint = spots[Math.floor(Math.random() * spots.length)];
    }
    const dx = waypoint.x - me.x;
    const dz = waypoint.z - me.z;
    const d = Math.hypot(dx, dz);
    if (d < 1) {
      waypoint = null;
      pauseUntil = now + 1000 + Math.random() * 3000;
      return;
    }
    step(dx, dz, Math.min(d / dt, TOWN_WALK_SPEED * 0.75), dt, false);
  }

  function tick() {
    const now = Date.now();
    const dt = TOWN_TICK_MS / 1000;
    me.speed = 0;
    let fighting = false;
    if (!down && now >= stunnedUntil && now >= restUntil) {
      const p = foe(now);
      const card = p ? null : cardToTake();
      if (p) {
        fighting = true;
        fight(p, dt, now);
      } else if (card) {
        const d = Math.hypot(card.x - me.x, card.z - me.z);
        if (d > WILDS_DROP.reach * 0.6)
          step(card.x - me.x, card.z - me.z, Math.min(d / dt, TOWN_WALK_SPEED * 0.9), dt, false);
        else if (now >= takeAt) {
          takeAt = now + 2000;
          json({ t: "wildsTake", id: card.id });
        }
      } else wander(dt, now);
    }
    ws.send(
      encodeStateFrame(++stateSeq & 0xffff, {
        x: me.x,
        z: me.z,
        heading: me.heading,
        speed: me.speed,
        flags: withCastSeq(fighting ? TOWN_FLAG_COMBAT : 0, casts),
      }),
    );
  }

  ws.onmessage = async (e) => {
    if (typeof e.data !== "string") {
      const snap = decodeSnapshot(e.data);
      if (!snap) return;
      clockOffset = snap.serverTime - Date.now();
      for (const en of snap.entries) if (en.id !== you) seen.set(en.id, en.state);
      return;
    }
    const m = JSON.parse(e.data);
    switch (m.t) {
      case "welcome":
        you = m.you;
        for (const p of m.players) if (p.id !== you) names.set(p.id, p.name);
        log(
          `on the Wilds (shard ${shard}) as "${name}", ${cls} level ${level}; ` +
            `here: ${[...names.values()].map((n) => `"${n}"`).join(", ") || "nobody"}`,
        );
        clearInterval(loop);
        loop = setInterval(tick, TOWN_TICK_MS);
        clearInterval(renew);
        renew = setInterval(async () => json({ t: "ticket", ticket: (await ticket()).ticket }), 5 * 60_000);
        break;
      case "join":
        if (m.player.id === you) break;
        if (!names.has(m.player.id)) log(`"${m.player.name}" arrived`);
        names.set(m.player.id, m.player.name);
        break;
      case "look":
        names.set(m.player.id, m.player.name);
        break;
      case "leave":
        if (names.has(m.id)) log(`"${who(m.id)}" left`);
        seen.delete(m.id);
        names.delete(m.id);
        standing.delete(m.id);
        break;
      case "correct":
        me.x = m.x;
        me.z = m.z;
        break;
      case "pvp": {
        if (m.id !== you) {
          standing.set(m.id, m);
          break;
        }
        const wasDown = down;
        if (m.by !== undefined && m.by !== you && m.hp < myHp * m.maxHp && !m.down) {
          if (grudge.id !== m.by || grudge.until < Date.now()) log(`hit by "${who(m.by)}": fighting back`);
          grudge = { id: m.by, until: Date.now() + GRUDGE_MS };
        }
        myHp = m.hp / m.maxHp;
        down = m.down !== undefined;
        if (down && !wasDown) {
          target = -1;
          grudge = { id: -1, until: 0 };
          me.speed = 0;
        } else if (!down && wasDown) {
          log(`up in the camp (${m.hp}/${m.maxHp}); setting off again`);
          restUntil = Date.now() + GET_UP_PAUSE_MS;
          waypoint = null;
          readyAt.clear();
          topUp().catch((err) => log(`top-up failed: ${err.message}`));
        }
        break;
      }
      case "pvpStun":
        if (m.id === you) stunnedUntil = Date.now() + Math.max(0, m.until - serverNow());
        break;
      case "pvpFeed":
        log(`"${m.byName}" took down "${m.victimName}"${m.logged ? " (left mid-fight)" : ""}`);
        if (m.by === you) {
          target = -1;
          await sleep(900);
          json({ t: "emote", e: "cheer" });
        }
        break;
      case "wildsLoot":
        drops.clear();
        for (const d of m.drops) drops.set(d.id, d);
        if (m.drops.length) log(`${m.drops.length} card(s) on the ground`);
        break;
      case "wildsDrop":
        drops.set(m.drop.id, m.drop);
        log(
          `"${who(m.from)}" dropped "${m.drop.item}" at (${fmt(m.drop.x)}, ${fmt(m.drop.z)}); ` +
            `${m.drop.firstFor === null ? "anyone's" : `"${who(m.drop.firstFor)}"'s first`}`,
        );
        break;
      case "wildsLost":
        log(`bot lost "${m.item}"${m.level ? ` +${m.level}` : ""}`);
        break;
      case "wildsGone":
        if (drops.delete(m.id))
          log(`card ${m.id.slice(0, 8)} ${m.by != null ? `taken by "${who(m.by)}"` : "gone back to its owner"}`);
        break;
      case "wildsTaken":
        log(`bot took "${m.item}"`);
        break;
      case "wildsRefused":
        if (m.why === "gone") drops.delete(m.id);
        log(`take refused: ${m.why}`);
        break;
    }
  };

  ws.onclose = (e) => {
    clearInterval(loop);
    clearInterval(renew);
    if (e.code === TOWN_CLOSE.replaced) {
      log(`"${name}" connected elsewhere: stopping`);
      process.exit(0);
    }
    log(`socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""}); reconnecting in 3 s`);
    setTimeout(run, 3000);
  };
  ws.onerror = () => {};
}

await topUp();
run();
