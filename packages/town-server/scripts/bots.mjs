#!/usr/bin/env node
/**
 * Fills the multiplayer Town with walking bots, for load tests and for
 * having company in the sandbox.
 *
 *   node scripts/bots.mjs [count=10] [seconds=60]
 *
 * Env: TOWN_URL (default ws://localhost:8787), TOWN_TICKET_SECRET (default
 * dev-town-secret, matching .dev.vars), SHARD (default 0).
 *
 * Bots walk in circles at walking speed, sending state at the client's rate
 * (15 Hz). At the end it prints, per bot, how many snapshots and bytes it
 * received and how late snapshots arrived against the tick.
 */
import {
  decodeSnapshot,
  encodeStateFrame,
  signTownTicket,
  TOWN_PROTOCOL,
  TOWN_TICK_MS,
  TOWN_WALK_SPEED,
} from "@herzies/shared/town-net";

const count = Number(process.argv[2] ?? 10);
const seconds = Number(process.argv[3] ?? 60);
const url = process.env.TOWN_URL ?? "ws://localhost:8787";
const secret = process.env.TOWN_TICKET_SECRET ?? "dev-town-secret";
const shard = process.env.SHARD ?? "0";

const stats = [];

async function bot(i) {
  const uid = `bot-${i}`;
  const exp = Math.floor(Date.now() / 1000) + 600;
  const ticket = await signTownTicket(
    {
      uid,
      name: `bot ${i}`,
      look: { seed: `bot-seed-${i}`, stage: 1 + (i % 3) },
      exp,
    },
    secret,
  );
  const ws = new WebSocket(`${url}/v1/town/home?shard=${shard}`);
  ws.binaryType = "arraybuffer";
  const s = { i, snapshots: 0, bytes: 0, gaps: [], closed: null, others: 0 };
  stats.push(s);
  const radius = 6 + (i % 10) * 2.5;
  const phase = (i / count) * Math.PI * 2;
  let angle = phase;
  let seq = 0;
  let loop;
  let lastSnap = 0;
  ws.onopen = () => {
    const at = { x: Math.sin(angle) * radius, z: Math.cos(angle) * radius };
    ws.send(
      JSON.stringify({
        t: "hello",
        v: TOWN_PROTOCOL,
        ticket,
        at: { ...at, heading: 0, speed: 0, flags: 0 },
      }),
    );
  };
  ws.onmessage = (e) => {
    if (typeof e.data === "string") {
      const m = JSON.parse(e.data);
      if (m.t === "welcome") {
        s.others = m.players.length;
        loop = setInterval(() => {
          angle += ((TOWN_WALK_SPEED * 0.9) / radius) * (TOWN_TICK_MS / 1000);
          const x = Math.sin(angle) * radius;
          const z = Math.cos(angle) * radius;
          seq++;
          ws.send(
            encodeStateFrame(seq, {
              x,
              z,
              heading: angle + Math.PI / 2,
              speed: TOWN_WALK_SPEED * 0.9,
              flags: 0,
            }),
          );
        }, TOWN_TICK_MS);
      } else if (m.t === "correct") s.corrections = (s.corrections ?? 0) + 1;
      return;
    }
    const snap = decodeSnapshot(e.data);
    if (!snap) return;
    const now = performance.now();
    if (lastSnap) s.gaps.push(now - lastSnap);
    lastSnap = now;
    s.snapshots++;
    s.bytes += e.data.byteLength;
  };
  ws.onclose = (e) => {
    s.closed = e.code;
    clearInterval(loop);
  };
  return () => {
    clearInterval(loop);
    ws.close(1000);
  };
}

const stops = [];
for (let i = 0; i < count; i++) {
  stops.push(await bot(i));
  await new Promise((r) => setTimeout(r, 50));
}
await new Promise((r) => setTimeout(r, seconds * 1000));
for (const stop of stops) stop();

const pct = (xs, p) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};
const allGaps = stats.flatMap((s) => s.gaps);
const totalBytes = stats.reduce((n, s) => n + s.bytes, 0);
console.log(
  JSON.stringify(
    {
      bots: count,
      seconds,
      closedEarly: stats.filter((s) => s.closed !== null).map((s) => [s.i, s.closed]),
      corrections: stats.reduce((n, s) => n + (s.corrections ?? 0), 0),
      snapshotsPerBotPerSec: Number(
        (stats.reduce((n, s) => n + s.snapshots, 0) / count / seconds).toFixed(1),
      ),
      kBPerBotPerSec: Number((totalBytes / count / seconds / 1024).toFixed(2)),
      snapshotGapMs: {
        p50: Number(pct(allGaps, 0.5).toFixed(1)),
        p95: Number(pct(allGaps, 0.95).toFixed(1)),
        p99: Number(pct(allGaps, 0.99).toFixed(1)),
      },
    },
    null,
    1,
  ),
);
process.exit(0);
