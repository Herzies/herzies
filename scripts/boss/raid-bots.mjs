// Three local teammates for a boss raid: a Bard, a Percussionist and a
// Record Slinger, each a real herzie with a real ticket on the LOCAL stack,
// in the cave's lobby before it locks, then fighting: dodging the shapes on
// the floor, attacking (minions first, except the tank), healing, taunting,
// Cymbrella on a buster, Backspin, resurrecting whoever's down (you too),
// and listening to what the boss hates.
//
//   ANON_KEY=… SERVICE_ROLE_KEY=… node raid-bots.mjs [LOBBY_SECONDS] [HP_PER_HERZIE] [CAST]
//
// CAST: "mixed" (the six above, the default) or "nobards": ten with no
// healer at all, levels 1 to 30, the stage-1 ones classless (they bump).
import { createRequire } from "node:module";

const ROOT = new globalThis.URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const require = createRequire(`${ROOT}/packages/web/package.json`);
const { createClient } = require("@supabase/supabase-js");
const net = await import(`${ROOT}/packages/shared/dist/town-net.js`);
const combat = await import(`${ROOT}/packages/shared/dist/combat.js`);
const { SKILL_DEFS } = await import(`${ROOT}/packages/shared/dist/skills.js`);
const { MOB } = await import(`${ROOT}/packages/shared/dist/tower.js`);

const LOBBY_S = Number(process.argv[2] ?? 20);
const HP_PER = Number(process.argv[3] ?? 20000);
const CAST_NAME = process.argv[4] ?? "mixed";
const URL = "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const SERVICE = process.env.SERVICE_ROLE_KEY;
if (!ANON || !SERVICE) throw new Error("ANON_KEY / SERVICE_ROLE_KEY");
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const T0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s`, ...a);
const must = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
};

const ROOM_R = 13 - 0.6;
const STEP_MS = 100;
const SPEED = net.TOWN_WALK_SPEED;
const { BOSS_STAND, CAST_INTERVAL_MS, DISC_RANGE, MELEE_REACH, WAVE_HAND_HEIGHT } = combat;

// --- The cast, made once and reused (full health, on their feet). The
// strong ones are level 30, quick and careful; the weak ones are low level,
// slow to notice a shape on the floor, often don't move at all, and the weak
// Percussionist never taunts.
const STRONG = { reaction: 350, dodge: 1, taunts: true };
const WEAK = { reaction: 900, dodge: 0.45, taunts: false };
// Barely playing: slow to see anything, and mostly standing in it.
const FEEBLE = { reaction: 1300, dodge: 0.2, taunts: false };
const MIXED = [
  { role: "bard", name: "Lutey", level: 30, look: [1, 2, 1, 0, 1, 2, 1], stats: { stat_euphony: 30, stat_sonic: 28 }, ...STRONG },
  { role: "percussionist", name: "Thumpy", level: 30, look: [3, 1, 2, 1, 2, 0, 2], stats: { stat_stamina: 40, stat_sonic: 18 }, ...STRONG },
  { role: "record_slinger", name: "Spinny", level: 30, look: [2, 0, 3, 2, 0, 1, 0], stats: { stat_sonic: 58 }, ...STRONG },
  { role: "bard", name: "Wobbly", level: 10, look: [0, 3, 0, 1, 3, 1, 3], stats: { stat_euphony: 10, stat_sonic: 8 }, ...WEAK },
  { role: "percussionist", name: "Clanky", level: 12, look: [4, 2, 1, 2, 1, 3, 1], stats: { stat_stamina: 16, stat_sonic: 6 }, ...WEAK },
  { role: "record_slinger", name: "Scratchy", level: 9, look: [1, 4, 2, 0, 2, 2, 2], stats: { stat_sonic: 16 }, ...WEAK },
];
const NO_BARDS = [
  { role: "percussionist", name: "Thumpy", level: 30, look: [3, 1, 2, 1, 2, 0, 2], stats: { stat_stamina: 40, stat_sonic: 18 }, ...STRONG },
  { role: "record_slinger", name: "Spinny", level: 30, look: [2, 0, 3, 2, 0, 1, 0], stats: { stat_sonic: 58 }, ...STRONG },
  { role: "percussionist", name: "Boomer", level: 22, look: [0, 1, 1, 3, 0, 2, 1], stats: { stat_stamina: 30, stat_sonic: 12 }, ...STRONG },
  { role: "record_slinger", name: "Diskette", level: 18, look: [4, 0, 2, 1, 1, 0, 3], stats: { stat_sonic: 34 }, ...WEAK },
  { role: "percussionist", name: "Clanky", level: 12, look: [4, 2, 1, 2, 1, 3, 1], stats: { stat_stamina: 16, stat_sonic: 6 }, ...WEAK },
  { role: "record_slinger", name: "Scratchy", level: 9, look: [1, 4, 2, 0, 2, 2, 2], stats: { stat_sonic: 16 }, ...WEAK },
  { role: "none", name: "Pebble", level: 5, look: [2, 2, 0, 0, 3, 1, 0], stats: { stat_sonic: 8 }, ...FEEBLE },
  { role: "none", name: "Mote", level: 3, look: [3, 3, 3, 1, 0, 0, 1], stats: { stat_stamina: 4 }, ...FEEBLE },
  { role: "none", name: "Twig", level: 2, look: [1, 1, 4, 2, 2, 3, 2], stats: {}, ...FEEBLE },
  { role: "none", name: "Smol", level: 1, look: [0, 4, 1, 0, 1, 1, 3], stats: {}, ...FEEBLE },
];
const CAST = CAST_NAME === "nobards" ? NO_BARDS : MIXED;
/** Cumulative XP for a level (totalXpForLevel), as scripts/local.sh does. */
const xpFor = (level) => {
  let xp = 0;
  for (let i = 2; i <= level; i++) xp += Math.floor(100 * i ** 1.5);
  return xp;
};
const PASSWORD = "bot-password-123";

async function herzie(c) {
  const email = `bot-${c.name.toLowerCase()}@herzies.test`;
  const anon = createClient(URL, ANON, { auth: { persistSession: false } });
  let { data: s } = await anon.auth.signInWithPassword({ email, password: PASSWORD });
  if (!s?.session) {
    must(await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true }), "user");
    ({ data: s } = await anon.auth.signInWithPassword({ email, password: PASSWORD }));
  }
  const uid = s.user.id;
  const { data: had } = await admin.from("herzies").select("class").eq("user_id", uid).maybeSingle();
  const [headIndex, eyesIndex, mouthIndex, accessoryIndex, limbsIndex, bodyIndex, legsIndex] = c.look;
  const row = {
    name: c.name,
    level: c.level,
    stage: c.level >= 25 ? 3 : c.level >= 10 ? 2 : 1,
    xp: xpFor(c.level),
    hp: null,
    hp_at: null,
    down: false,
    stat_stamina: 0,
    stat_sonic: 0,
    stat_euphony: 0,
    ...c.stats,
  };
  if (!had) {
    must(
      await admin.from("herzies").insert({
        user_id: uid,
        friend_code: `HERZ-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        appearance: { headIndex, eyesIndex, mouthIndex, accessoryIndex, limbsIndex, bodyIndex, legsIndex, colorScheme: "pink" },
        total_minutes_listened: 0,
        genre_minutes: {},
        friend_codes: [],
        currency: 100,
        ...row,
      }),
      "herzie",
    );
  } else {
    must(await admin.from("herzies").update(row).eq("user_id", uid), "herzie");
  }
  // Classless (stage 1): it bumps.
  if (!had?.class && c.role !== "none")
    must(await admin.rpc("choose_class", { p_user_id: uid, p_class: c.role }), "class");
  return { ...c, uid, token: s.session.access_token };
}
const bots = await Promise.all(CAST.map(herzie));
const botUids = new Set(bots.map((b) => b.uid));

// --- A fresh boss: its lobby open now, locking in LOBBY_S seconds.
for (const t of ["boss_fight_log", "boss_participants", "boss_damage", "boss_state"])
  await admin.from(t).delete().not("event_id", "is", null);
await admin.from("events").delete().eq("type", "boss_fight");
const starts = new Date(Date.now() + LOBBY_S * 1000);
const event = must(
  await admin.rpc("create_boss_event", {
    p_title: "Local Boss",
    p_description: "Listen to what it hates.",
    p_starts_at: starts.toISOString(),
    p_ends_at: new Date(starts.getTime() + 3_600_000).toISOString(),
    p_template: { rewardItemId: "cd", hpPerPlayer: HP_PER },
  }),
  "event",
);
log(`boss ${event}: lobby open, it wakes at ${starts.toISOString().slice(11, 19)} UTC`);

// --- Into the cave.
async function ticket(b) {
  const r = await fetch(`${URL}/functions/v1/town-ticket?map=bossroom`, {
    headers: { authorization: `Bearer ${b.token}`, apikey: ANON },
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`ticket ${b.name}: ${r.status} ${JSON.stringify(body)}`);
  return body;
}

/** What one bot knows of the room. Times in server clock unless noted. */
function freshView() {
  return {
    you: null,
    offset: 0,
    boss: { x: BOSS_STAND.x, z: BOSS_STAND.z },
    tgs: new Map(), // id -> telegraph (+ seenAt, local ms)
    mobs: [],
    hp: new Map(), // entity -> { hp, maxHp }
    pos: new Map(), // entity -> { x, z }
    names: new Map(),
    raid: null,
    down: false,
    over: false,
  };
}

function connect(b, at) {
  return new Promise(async (resolve, reject) => {
    const t = await ticket(b);
    const ws = new WebSocket(`${t.url.replace(/^http/, "ws")}/v1/town/bossroom?shard=0`);
    ws.binaryType = "arraybuffer";
    Object.assign(b, { ws, at: { ...at }, v: freshView(), seq: 0, casts: 0, nextCast: 0, ready: new Map(), skillSeq: 0, channelUntil: 0, tunedTo: undefined, heading: Math.PI });
    const v = b.v;
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        const snap = net.decodeSnapshot(e.data);
        if (snap) {
          v.offset = snap.serverTime - Date.now();
          for (const en of snap.entries) v.pos.set(en.id, { x: en.state.x, z: en.state.z });
        }
        return;
      }
      if (e.data === net.TOWN_PONG) return;
      const m = JSON.parse(e.data);
      switch (m.t) {
        case "welcome":
          v.you = m.you;
          for (const p of m.players) v.names.set(p.id, p.name);
          if (m.fight) {
            v.offset = m.fight.now - Date.now();
            for (const h of m.fight.health) v.hp.set(h.id, h);
            for (const tg of m.fight.telegraphs) v.tgs.set(tg.id, { ...tg, seenAt: Date.now() });
            if (m.fight.raid) v.raid = m.fight.raid;
            if (m.fight.bossAt) v.boss = m.fight.bossAt;
          }
          resolve(b);
          break;
        case "join":
        case "look":
          v.names.set(m.player.id, m.player.name);
          break;
        case "leave":
          v.pos.delete(m.id);
          v.hp.delete(m.id);
          break;
        case "bossAt":
          v.boss = m;
          break;
        case "telegraph":
          v.tgs.set(m.id, { ...m, seenAt: Date.now() });
          break;
        case "resolve":
          v.tgs.delete(m.id);
          break;
        case "hp":
          v.hp.set(m.id, m);
          if (m.id === v.you && m.hp > 0) v.down = false;
          break;
        case "mobs":
          v.mobs = m.mobs;
          break;
        case "mobDown":
          v.mobs = v.mobs.filter((x) => x.id !== m.mob);
          break;
        case "raid":
          v.raid = { ...v.raid, ...m };
          break;
        case "down":
          v.down = true;
          log(`${b.name} is knocked out`);
          break;
        case "revived":
          if (m.id === v.you) v.down = false;
          if (b === bots[0]) log(`${v.names.get(m.by) ?? m.by} brought ${v.names.get(m.id) ?? m.id} back`);
          break;
        case "skillDenied":
          // Not ready after all: try again a little later.
          if (m.skill) b.ready.set(m.skill, Date.now() + 1_000);
          break;
        case "victory":
          if (b === bots[0]) log("VICTORY");
          v.over = true;
          break;
        case "closing":
          if (b === bots[0]) log(`room closing: ${m.why}`);
          v.over = true;
          break;
        case "say":
          if (b === bots[0]) log(`boss: "${m.text}"`);
          break;
        case "out":
          log(`${b.name} is out of the fight`);
          break;
      }
    };
    ws.onclose = (e) => {
      log(`${b.name} left (${e.code} ${e.reason})`);
      b.closed = true;
    };
    ws.onerror = (e) => reject(e);
    ws.onopen = () =>
      ws.send(JSON.stringify({ t: "hello", v: net.TOWN_PROTOCOL, ticket: t.ticket, at: { x: at.x, z: at.z, heading: Math.PI, speed: 0, flags: 0 } }));
  });
}

const spawn = CAST.map((_, i) => ({ x: -5 + (10 * i) / Math.max(1, CAST.length - 1), z: 8 + (i % 2) }));
await Promise.all(bots.map((b, i) => connect(b, spawn[i])));
log(`${bots.map((b) => b.name).join(", ")} are in the lobby`);

// --- Geometry.
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
function covers(tg, x, z, margin) {
  const d = Math.hypot(x - tg.x, z - tg.z);
  if (tg.kind === "ring") return d <= tg.r + margin && d >= Math.max(0, tg.inner - margin);
  return d <= tg.r + margin;
}
/** The nearest spot clear of every shape this bot has noticed, or null if
 * standing here is fine. */
function safeSpot(tgs, x, z) {
  const M = 0.6;
  const clear = (px, pz) => tgs.every((tg) => !covers(tg, px, pz, M));
  if (clear(x, z)) return null;
  let best = null;
  let bestD = Infinity;
  for (let gx = -ROOM_R; gx <= ROOM_R; gx += 0.5)
    for (let gz = -ROOM_R; gz <= ROOM_R; gz += 0.5) {
      if (Math.hypot(gx, gz) > ROOM_R) continue;
      const d = Math.hypot(gx - x, gz - z);
      if (d < bestD && clear(gx, gz)) {
        bestD = d;
        best = { x: gx, z: gz };
      }
    }
  return best;
}
function stepToward(b, to, stop = 0) {
  const d = dist(b.at, to);
  if (d <= stop + 0.05) return false;
  const step = Math.min(d - stop, (SPEED * STEP_MS) / 1000);
  b.at.x += ((to.x - b.at.x) / d) * step;
  b.at.z += ((to.z - b.at.z) / d) * step;
  const r = Math.hypot(b.at.x, b.at.z);
  if (r > ROOM_R) {
    b.at.x *= ROOM_R / r;
    b.at.z *= ROOM_R / r;
  }
  return true;
}
function aimAt(b, target, chest) {
  const dx = target.x - b.at.x;
  const dz = target.z - b.at.z;
  return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(chest - WAVE_HAND_HEIGHT, Math.hypot(dx, dz)) };
}
function useSkill(b, skill, yaw = b.heading, pitch = 0) {
  const now = Date.now();
  if ((b.ready.get(skill) ?? 0) > now) return false;
  const def = SKILL_DEFS[skill];
  b.ready.set(skill, now + (def.channelMs ?? 0) + def.cooldownMs);
  b.ws.send(JSON.stringify({ t: "skill", skill, seq: ++b.skillSeq, yaw, pitch }));
  return true;
}

// --- Each bot's brain, ten times a second.
function think(b) {
  const v = b.v;
  if (b.closed || v.over || v.you === null) return;
  const now = Date.now();
  const stage = v.raid?.stage ?? "lobby";
  let moved = false;

  // Music on: the boss hates it.
  if (b.tunedTo !== true && now - (b.tunedAt ?? 0) > 1_800) {
    b.ws.send(JSON.stringify({ t: "tune", on: true }));
    b.tunedTo = true;
    b.tunedAt = now;
  }

  if (stage === "fight" && !v.down) {
    const serverNow = now + v.offset;
    for (const [id, tg] of v.tgs) if (tg.hitAt + 600 < serverNow) v.tgs.delete(id);
    // Each shape, once: does this one even see it coming?
    b.heeds ??= new Map();
    const noticed = [...v.tgs.values()].filter((tg) => {
      if (!b.heeds.has(tg.id)) b.heeds.set(tg.id, Math.random() < b.dodge);
      return b.heeds.get(tg.id) && now - tg.seenAt >= b.reaction && tg.kind !== "buster" && !tg.lethal;
    });
    if (b.heeds.size > 200) b.heeds.clear();
    const channeling = now < b.channelUntil;
    const escape = channeling ? null : safeSpot(noticed, b.at.x, b.at.z);
    const boss = v.boss;
    const toBoss = dist(b.at, boss);
    const allies = [...v.hp.entries()]
      .filter(([id]) => id !== v.you && v.pos.has(id))
      .map(([id, h]) => ({ id, ...h, ...v.pos.get(id) }));
    const fallen = allies.filter((a) => a.hp <= 0);

    if (escape) moved = stepToward(b, escape);
    else if (!channeling) {
      if (b.role === "bard") {
        const res = SKILL_DEFS.resurrect;
        const target = fallen.sort((p, q) => dist(b.at, p) - dist(b.at, q))[0];
        const resReady = (b.ready.get("resurrect") ?? 0) <= now && (v.raid?.charges ?? 0) > 0;
        if (target && resReady) {
          moved = stepToward(b, target, 1.5);
          if (!moved && dist(b.at, target) <= (res.radius ?? 4) - 0.5 && useSkill(b, "resurrect")) {
            b.channelUntil = now + (res.channelMs ?? 3000) + 300;
            log(`${b.name} plays ${v.names.get(target.id) ?? "someone"} back up…`);
          }
        } else {
          // Behind the group, out of melee, on the spawn side.
          const standing = allies.filter((a) => a.hp > 0);
          const c = standing.length
            ? { x: standing.reduce((n, a) => n + a.x, 0) / standing.length, z: standing.reduce((n, a) => n + a.z, 0) / standing.length }
            : { x: 0, z: 6 };
          moved = stepToward(b, { x: c.x * 0.5, z: Math.max(c.z, boss.z + 8) }, 2.5);
        }
      } else if (b.role === "percussionist" || b.role === "none") {
        // Melee: a stick, or a classless herzie's bump.
        moved = stepToward(b, boss, BOSS_STAND.radius + MELEE_REACH * 0.6);
      } else {
        if (toBoss > DISC_RANGE - 8) moved = stepToward(b, boss, DISC_RANGE - 10);
        else if (toBoss < 8) moved = stepToward(b, { x: b.at.x + (b.at.x - boss.x), z: b.at.z + (b.at.z - boss.z) });
      }
    }

    // Skills.
    if (b.role === "bard" && !channeling) {
      const drones = SKILL_DEFS["soothing-drones"];
      const me = v.hp.get(v.you);
      const hurt =
        (me && me.hp / me.maxHp < 0.7) ||
        allies.some((a) => a.hp > 0 && a.hp / a.maxHp < 0.7 && dist(b.at, a) <= (drones.radius ?? 8));
      if (hurt) useSkill(b, "soothing-drones");
    } else if (b.role === "percussionist") {
      if (b.taunts) useSkill(b, "taunt");
      const buster = [...v.tgs.values()].some((tg) => tg.kind === "buster" && tg.target === v.you);
      if (buster) useSkill(b, "cymbrella");
    }

    // Attack: minions first (not the tank), else the boss.
    if (!channeling && now >= b.nextCast) {
      b.nextCast = now + CAST_INTERVAL_MS + 20;
      let target = boss;
      let chest = BOSS_STAND.chest;
      if (b.role !== "percussionist") {
        let best = b.role === "record_slinger" ? DISC_RANGE : 30;
        for (const m of v.mobs) {
          const d = dist(b.at, m);
          if (d < best) {
            best = d;
            target = m;
            chest = MOB.chest;
          }
        }
      }
      const { yaw, pitch } = aimAt(b, target, chest);
      b.heading = yaw;
      if (b.role === "record_slinger") useSkill(b, "backspin", yaw, pitch);
      b.ws.send(net.encodeCastFrame({ seq: ++b.casts & 0xffff, yaw, pitch }));
    }
    if (!moved) b.heading = Math.atan2(boss.x - b.at.x, boss.z - b.at.z);
  } else if (stage === "lobby") {
    // Mill about near the door, facing the sleeping boss.
    b.heading = Math.atan2(v.boss.x - b.at.x, v.boss.z - b.at.z);
  }

  let flags = net.TOWN_FLAG_COMBAT;
  flags = net.withCastSeq(flags, b.casts);
  b.ws.send(
    net.encodeStateFrame(++b.seq & 0xffff, {
      x: b.at.x,
      z: b.at.z,
      heading: b.heading,
      speed: moved ? SPEED : 0,
      flags,
    }),
  );
}

const tick = setInterval(() => {
  for (const b of bots) if (b.ws.readyState === 1) think(b);
  if (bots.every((b) => b.closed || b.v.over)) {
    clearInterval(tick);
    setTimeout(() => {
      for (const b of bots) b.ws.close();
      log("done");
      process.exit(0);
    }, 8_000);
  }
}, STEP_MS);

// Fresh tickets before theirs run out, and a ping now and then.
setInterval(async () => {
  for (const b of bots) {
    if (b.closed) continue;
    try {
      const t = await ticket(b);
      b.ws.send(JSON.stringify({ t: "ticket", ticket: t.ticket }));
    } catch (e) {
      log(`${b.name}: ticket renewal failed: ${e.message}`);
    }
  }
}, 5 * 60_000);
setInterval(() => bots.forEach((b) => b.ws.readyState === 1 && b.ws.send(net.TOWN_PING)), 20_000);
