#!/usr/bin/env node
/**
 * Fills the boss's cave with bots that fight it, so a person can walk in
 * and fight alongside them (or load-test the room).
 *
 *   node scripts/boss-bots.mjs [count=4] [seconds=120] [dodge=1]
 *
 * Env: TOWN_URL (default ws://localhost:8787), TOWN_TICKET_SECRET (default
 * dev-town-secret, as in .dev.vars), BOSS_HP (default 20000), BOSS_EVENT
 * (default "dev"; must match the room's fight, which starts from the first
 * ticket's boss claim). Bots sign their own tickets, boss claim included,
 * so this needs no database or events. Without DEV_BOSS in the room's
 * vars, a real player needs a real ticket (or the dev bypass) to join too.
 *
 * Each bot casts at the boss every ~650 ms and, unless dodge=0, steps out
 * of any telegraphed shape it's standing in. Prints what happened.
 */
import {
  encodeCastFrame,
  encodeStateFrame,
  signTownTicket,
  TOWN_PROTOCOL,
  TOWN_TICK_MS,
  TOWN_WALK_SPEED,
} from "@herzies/shared/town-net";

const count = Number(process.argv[2] ?? 4);
const seconds = Number(process.argv[3] ?? 120);
const dodge = (process.argv[4] ?? "1") !== "0";
const url = process.env.TOWN_URL ?? "ws://localhost:8787";
const secret = process.env.TOWN_TICKET_SECRET ?? "dev-town-secret";
const bossHp = Number(process.env.BOSS_HP ?? 20_000);
const event = process.env.BOSS_EVENT ?? "dev";
const BOSS = { x: 0, z: -4, chest: 2.4 };

const results = [];

async function bot(i) {
  const uid = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const ticket = await signTownTicket(
    {
      uid,
      name: `cave bot ${i}`,
      look: { seed: `bot-seed-${i}`, stage: 2 },
      // Wave casters: without a class a herzie melees, and these cast from
      // across the room.
      cls: "bard",
      exp: Math.floor(Date.now() / 1000) + 600,
      hp: { hp: 300, maxHp: 300, down: false },
      st: [10, 0, 5, 50],
      boss: {
        event,
        until: Math.floor(Date.now() / 1000) + 3600,
        hp: bossHp,
        maxHp: bossHp,
      },
    },
    secret,
  );
  const r = { i, telegraphs: 0, hits: 0, damage: 0, hp: 300, down: false, closed: null, bossHp };
  results.push(r);
  let x = ((i % 5) - 2) * 2.4;
  let z = 6 + Math.floor(i / 5) * 2;
  let seq = 0;
  let castSeq = 0;
  const shapes = new Map();
  const ws = new WebSocket(`${url}/v1/town/bossroom?shard=0`);
  ws.binaryType = "arraybuffer";
  let timer;
  ws.onopen = () =>
    ws.send(
      JSON.stringify({
        t: "hello",
        v: TOWN_PROTOCOL,
        ticket,
        at: { x, z, heading: Math.PI, speed: 0, flags: 0 },
      }),
    );
  const inside = (s, px, pz) => {
    const d = Math.hypot(px - s.x, pz - s.z);
    return d <= s.r && d >= s.inner;
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    const m = JSON.parse(e.data);
    if (m.t === "welcome") {
      if (m.fight) {
        for (const t of m.fight.telegraphs) shapes.set(t.id, t);
        r.bossHp = m.fight.hp;
      }
      timer = setInterval(() => {
        if (r.down) return;
        const now = Date.now();
        // Step out of anything we're standing in: toward the nearest clear
        // point on a coarse ring of candidates around us.
        const live = [...shapes.values()];
        if (dodge && live.some((s) => inside(s, x, z))) {
          let best = null;
          for (let a = 0; a < 16; a++) {
            for (const d of [1.5, 3, 4.5, 6, 8]) {
              const cx = x + Math.sin((a / 16) * Math.PI * 2) * d;
              const cz = z + Math.cos((a / 16) * Math.PI * 2) * d;
              if (Math.hypot(cx, cz) > 12.5) continue;
              if (live.some((s) => inside({ ...s, r: s.r + 0.6, inner: Math.max(0, s.inner - 0.6) }, cx, cz))) continue;
              if (!best || d < best.d) best = { cx, cz, d };
            }
          }
          if (best) {
            const dx = best.cx - x;
            const dz = best.cz - z;
            const len = Math.hypot(dx, dz) || 1;
            const step = Math.min(len, TOWN_WALK_SPEED * 0.95 * (TOWN_TICK_MS / 1000));
            x += (dx / len) * step;
            z += (dz / len) * step;
          }
        }
        seq++;
        ws.send(encodeStateFrame(seq, { x, z, heading: Math.PI, speed: 0, flags: 0 }));
        if (now % 650 < TOWN_TICK_MS) {
          const dx = BOSS.x - x;
          const dz = BOSS.z - z;
          castSeq++;
          ws.send(
            encodeCastFrame({
              seq: castSeq,
              yaw: Math.atan2(dx, dz),
              pitch: Math.atan2(BOSS.chest - 1.2, Math.hypot(dx, dz)),
            }),
          );
        }
      }, TOWN_TICK_MS);
    } else if (m.t === "telegraph") {
      r.telegraphs++;
      shapes.set(m.id, m);
    } else if (m.t === "resolve") shapes.delete(m.id);
    else if (m.t === "hit") {
      r.hits++;
      r.damage += m.damage;
    } else if (m.t === "boss") r.bossHp = m.hp;
    else if (m.t === "hp" && m.id) r.hp = m.hp;
    else if (m.t === "down") r.down = true;
  };
  ws.onclose = (e) => {
    r.closed = e.code;
    clearInterval(timer);
  };
  return () => {
    clearInterval(timer);
    ws.close(1000);
  };
}

const stops = [];
for (let i = 0; i < count; i++) {
  stops.push(await bot(i));
  await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, seconds * 1000));
for (const stop of stops) stop();
console.log(
  JSON.stringify(
    {
      bots: count,
      seconds,
      dodge,
      bossHpNow: Math.min(...results.map((r) => r.bossHp)),
      totalDamage: results.reduce((n, r) => n + r.damage, 0),
      knockedOut: results.filter((r) => r.down).length,
      closed: results.filter((r) => r.closed !== null).map((r) => [r.i, r.closed]),
      perBot: results.map((r) => ({ i: r.i, hits: r.hits, damage: r.damage, hp: r.hp, telegraphsSeen: r.telegraphs })),
    },
    null,
    1,
  ),
);
