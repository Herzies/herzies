#!/usr/bin/env node
/**
 * A sparring partner for duels: one herzie that stands near the Home spawn,
 * waves when you come close, takes any challenge, and fights back: it
 * circles you, casts at you (missing some, so it can be beaten) and uses
 * its class skills. After a duel it asks for a rematch.
 *
 *   node scripts/duel-bot.mjs            (or: scripts/local.sh bot)
 *
 * Env:
 *   TOWN_URL            default ws://localhost:8787
 *   TOWN_TICKET_SECRET  default dev-town-secret (local.sh passes .dev.vars')
 *   SHARD               default 0 (where the app lands first)
 *   BOT_NAME            default Sparring Bot
 *   BOT_CLASS           bard | record_slinger | percussionist (default bard)
 *   BOT_LEVEL           default 20; with BOT_MATCH it becomes the challenger's
 *   BOT_MATCH           1 (default): fight at the challenger's level
 *   BOT_ACCURACY        0–1, the share of casts aimed true (default 0.55)
 *   BOT_TITLE           the title it wears (default duel-50, Dueling Banjos)
 *
 * It speaks the real protocol with a ticket it signs itself, so the Town
 * server judges its casts like anyone's; nothing here is special-cased on
 * the server.
 */
import { DUEL } from "@herzies/shared/duel";
import { SKILL_DEFS } from "@herzies/shared/skills";
import {
  decodeSnapshot,
  encodeCastFrame,
  encodeStateFrame,
  signTownTicket,
  TOWN_FLAG_COMBAT,
  TOWN_MAPS,
  TOWN_PROTOCOL,
  TOWN_TICK_MS,
  TOWN_WALK_SPEED,
  withCastSeq,
} from "@herzies/shared/town-net";
import { classOr, herzieKit } from "./bot-herzie.mjs";

const url = process.env.TOWN_URL ?? "ws://localhost:8787";
const secret = process.env.TOWN_TICKET_SECRET ?? "dev-town-secret";
const shard = process.env.SHARD ?? "0";
const name = process.env.BOT_NAME ?? "Sparring Bot";
const cls = classOr(process.env.BOT_CLASS, "bard");
const baseLevel = Number(process.env.BOT_LEVEL ?? 20);
const match = process.env.BOT_MATCH !== "0";
const accuracy = Math.max(0, Math.min(1, Number(process.env.BOT_ACCURACY ?? 0.55)));
const title = process.env.BOT_TITLE ?? "duel-50";
const uid = `duel-bot-${cls}`;

const MELEE = cls === "percussionist";
/** How far it likes to stand from you: in reach of its stick, or well
 * inside a wave's range but far enough to make you aim. */
const KEEP = MELEE ? 1.1 : 7;

async function ticketFor(level) {
  const { gear, ...kit } = herzieKit(cls, level);
  return signTownTicket(
    {
      uid,
      name,
      look: { seed: `BOT-${cls.toUpperCase()}`, stage: 3, equipped: gear },
      exp: Math.floor(Date.now() / 1000) + 600,
      ...kit,
      em: ["wave", "cheer"],
      ti: title,
    },
    secret,
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function run() {
  const spawn = TOWN_MAPS.home.spawn;
  const post = { x: spawn.x + 3, z: spawn.z + 3 };
  const me = { x: post.x, z: post.z, heading: 0, speed: 0 };
  /** Everyone else's latest position, by entity id. */
  const seen = new Map();
  const names = new Map();
  let you = -1;
  let level = baseLevel;
  let duel = null;
  let stunnedUntil = 0;
  let casts = 0;
  let castSeq = 0;
  let stateSeq = 0;
  let skillSeq = 0;
  let nextCastAt = 0;
  let strafe = 1;
  let waveAt = 0;
  let myHp = 1;
  const readyAt = new Map();
  /** Server clock minus ours, from snapshots. */
  let clockOffset = 0;
  const serverNow = () => Date.now() + clockOffset;
  let loop;
  let renew;

  const ws = new WebSocket(`${url}/v1/town/home?shard=${shard}`);
  ws.binaryType = "arraybuffer";
  const json = (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

  ws.onopen = async () => {
    json({
      t: "hello",
      v: TOWN_PROTOCOL,
      ticket: await ticketFor(level),
      at: { x: me.x, z: me.z, heading: 0, speed: 0, flags: 0 },
    });
  };

  const opponent = () => (duel ? (duel.a === you ? duel.b : duel.a) : -1);

  function aimAt(target, miss) {
    const dx = target.x - me.x;
    const dz = target.z - me.z;
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

  /** One step of the fight: move round the opponent, then maybe cast. */
  function fight(dt) {
    const foe = seen.get(opponent());
    if (!foe) return;
    const now = Date.now();
    const dx = me.x - foe.x;
    const dz = me.z - foe.z;
    const d = Math.hypot(dx, dz) || 0.01;
    if (now >= stunnedUntil) {
      // Circle at KEEP: the tangent sideways, plus a pull in or out.
      if (Math.random() < 0.01) strafe = -strafe;
      const tx = (-dz / d) * strafe;
      const tz = (dx / d) * strafe;
      const pull = Math.max(-1, Math.min(1, (KEEP - d) / 2));
      let vx = tx * (MELEE ? 0.35 : 0.6) + (dx / d) * pull;
      let vz = tz * (MELEE ? 0.35 : 0.6) + (dz / d) * pull;
      // Stay well inside the ring.
      const cx = me.x - duel.x;
      const cz = me.z - duel.z;
      const fromCentre = Math.hypot(cx, cz);
      if (fromCentre > DUEL.ringWarn - 2) {
        vx -= (cx / fromCentre) * 1.2;
        vz -= (cz / fromCentre) * 1.2;
      }
      const v = Math.hypot(vx, vz);
      const speed = Math.min(TOWN_WALK_SPEED * 0.9, v * TOWN_WALK_SPEED);
      if (v > 0.05) {
        me.x += (vx / v) * speed * dt;
        me.z += (vz / v) * speed * dt;
      }
      me.speed = v > 0.05 ? speed : 0;
    } else me.speed = 0;
    const { yaw, pitch, d: dist } = aimAt(foe, false);
    me.heading = yaw;
    if (now < stunnedUntil || now < nextCastAt) return;
    nextCastAt = now + 470 + Math.random() * 180;

    // Skills first, when they make sense.
    if (cls === "bard" && myHp < 0.55 && useSkill("soothing-drones", yaw, pitch)) return;
    if (cls === "bard" && useSkill("haste", yaw, pitch)) return;
    if (cls === "record_slinger" && dist < 14 && Math.random() < 0.3 && useSkill("backspin", yaw, pitch)) return;
    if (cls === "record_slinger" && useSkill("shuffle", yaw, pitch)) return;
    if (cls === "percussionist" && dist < 3 && useSkill("rimshot", yaw, pitch)) return;
    if (cls === "percussionist" && myHp < 0.5 && useSkill("cymbrella", yaw, pitch)) return;

    if (MELEE && dist > 1.9) return;
    const shot = aimAt(foe, Math.random() >= accuracy);
    casts++;
    ws.send(encodeCastFrame({ seq: (castSeq = (castSeq + 1) & 0xffff), yaw: shot.yaw, pitch: shot.pitch }));
  }

  /** Out of a duel: stand by the post, face whoever's nearest, wave at
   * newcomers. */
  function idle() {
    me.speed = 0;
    const dx = post.x - me.x;
    const dz = post.z - me.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.3) {
      const step = Math.min(d, TOWN_WALK_SPEED * 0.7 * (TOWN_TICK_MS / 1000));
      me.x += (dx / d) * step;
      me.z += (dz / d) * step;
      me.heading = Math.atan2(dx, dz);
      me.speed = TOWN_WALK_SPEED * 0.7;
      return;
    }
    let near = null;
    let best = 12;
    for (const [id, p] of seen) {
      if (id === you) continue;
      const pd = Math.hypot(p.x - me.x, p.z - me.z);
      if (pd < best) {
        best = pd;
        near = p;
      }
    }
    if (!near) return;
    me.heading = Math.atan2(near.x - me.x, near.z - me.z);
    if (best < 6 && Date.now() > waveAt) {
      waveAt = Date.now() + 30_000;
      json({ t: "emote", e: "wave" });
    }
  }

  ws.onmessage = async (e) => {
    if (typeof e.data !== "string") {
      const snap = decodeSnapshot(e.data);
      if (!snap) return;
      clockOffset = snap.serverTime - Date.now();
      for (const en of snap.entries) seen.set(en.id, en.state);
      return;
    }
    const m = JSON.parse(e.data);
    switch (m.t) {
      case "welcome":
        you = m.you;
        for (const p of m.players) names.set(p.id, p.name);
        log(`in Home (shard ${shard}) as "${name}", ${cls} level ${level}`);
        clearInterval(loop);
        loop = setInterval(() => {
          const dt = TOWN_TICK_MS / 1000;
          if (duel?.phase === "fight") fight(dt);
          else if (!duel) idle();
          else me.speed = 0;
          ws.send(
            encodeStateFrame(++stateSeq & 0xffff, {
              x: me.x,
              z: me.z,
              heading: me.heading,
              speed: me.speed,
              flags: withCastSeq(duel ? TOWN_FLAG_COMBAT : 0, casts),
            }),
          );
        }, TOWN_TICK_MS);
        clearInterval(renew);
        renew = setInterval(async () => json({ t: "ticket", ticket: await ticketFor(level) }), 5 * 60_000);
        break;
      case "join":
      case "look":
        names.set(m.player.id, m.player.name);
        break;
      case "leave":
        seen.delete(m.id);
        break;
      case "correct":
        me.x = m.x;
        me.z = m.z;
        break;
      case "duelAsk": {
        const who = names.get(m.from) ?? `#${m.from}`;
        if (duel) {
          json({ t: "duel", op: "answer", from: m.from, yes: false });
          break;
        }
        if (match && typeof m.lv === "number" && m.lv !== level) {
          level = m.lv;
          json({ t: "ticket", ticket: await ticketFor(level) });
          await sleep(300);
        }
        log(`"${who}" challenges (Lv ${m.lv ?? "?"} ${m.cls ?? ""}); accepting at level ${level}`);
        await sleep(700 + Math.random() * 500);
        json({ t: "duel", op: "answer", from: m.from, yes: true });
        break;
      }
      case "duel":
        if (m.a !== you && m.b !== you) break;
        if (!duel || duel.id !== m.id) log(`duel ${m.id}: countdown`);
        duel = m;
        for (const h of m.hp) if (h.id === you) myHp = h.hp / h.maxHp;
        if (m.phase === "fight") nextCastAt = Date.now() + 200 + Math.random() * 300;
        break;
      case "duelHp":
        if (m.id === you) myHp = m.hp / m.maxHp;
        break;
      case "duelStun":
        if (m.id === you) stunnedUntil = Date.now() + Math.max(0, m.until - serverNow());
        break;
      case "duelEnd": {
        if (m.a !== you && m.b !== you) break;
        const won = m.winner === you;
        log(`duel ${m.id}: ${m.why}, ${m.winner === null ? "no winner" : won ? "bot won" : "bot lost"} after ${(m.ms / 1000).toFixed(1)} s`);
        duel = null;
        stunnedUntil = 0;
        readyAt.clear();
        if (won) {
          await sleep(1200);
          json({ t: "emote", e: "cheer" });
        }
        if (m.rematchUntil) {
          await sleep(1800);
          json({ t: "duel", op: "rematch" });
        }
        break;
      }
      case "duelNo":
        log(`duel refused: ${m.why}`);
        break;
    }
  };

  ws.onclose = (e) => {
    clearInterval(loop);
    clearInterval(renew);
    log(`socket closed (${e.code}); reconnecting in 3 s`);
    setTimeout(run, 3000);
  };
  ws.onerror = () => {};
}

run();
