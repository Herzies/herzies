// End-to-end raid against the LOCAL stack: real tickets (town-ticket), the
// real Town server (wrangler dev on :8797) reporting to the real town-vitals,
// and the database checked afterwards.
//
// Cast: Bard A (casts, resurrects), B (1 HP: knocked out, then revived),
// C (1 HP: knocked out, then forfeits: out, unpaid).
import { createRequire } from "node:module";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const require = createRequire(`${ROOT}/packages/web/package.json`);
const { createClient } = require("@supabase/supabase-js");
const net = await import(`${ROOT}/packages/shared/dist/town-net.js`);

const URL = "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const SERVICE = process.env.SERVICE_ROLE_KEY;
if (!ANON || !SERVICE) throw new Error("ANON_KEY / SERVICE_ROLE_KEY");
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - T0) / 1000).toFixed(1)}s`, ...a);
const must = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
};

// --- Clean slate: no other boss event may overlap.
for (const t of ["boss_fight_log", "boss_participants", "boss_damage", "boss_state"])
  await admin.from(t).delete().not("event_id", "is", null);
await admin.from("events").delete().eq("type", "boss_fight");

// --- Three herzies.
async function herzie(tag, { cls, hp }) {
  const email = `raid-${tag}-${Date.now()}@herzies.test`;
  const { data: u } = await admin.auth.admin.createUser({
    email,
    password: "test-password-123",
    email_confirm: true,
  });
  const uid = u.user.id;
  must(
    await admin.from("herzies").insert({
      user_id: uid,
      name: `Raid${tag}`,
      friend_code: `HERZ-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      appearance: { headIndex: 0, eyesIndex: 0, mouthIndex: 0, accessoryIndex: 0, limbsIndex: 0, bodyIndex: 0, legsIndex: 0, colorScheme: "pink" },
      xp: 0, level: 30, stage: 3, total_minutes_listened: 0, genre_minutes: {}, friend_codes: [], currency: 100,
    }),
    "herzie",
  );
  if (cls) must(await admin.rpc("choose_class", { p_user_id: uid, p_class: cls }), "class");
  if (hp !== undefined)
    must(await admin.from("herzies").update({ hp, hp_at: new Date().toISOString() }).eq("user_id", uid), "hp");
  const anon = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: s } = await anon.auth.signInWithPassword({ email, password: "test-password-123" });
  return { tag, uid, token: s.session.access_token };
}
const A = await herzie("A", { cls: "bard" });
const B = await herzie("B", { hp: 1 });
const C = await herzie("C", { hp: 1 });

// --- A boss starting in 30 s: 400 HP a herzie (quick to fell).
const starts = new Date(Date.now() + 30_000);
const event = must(
  await admin.rpc("create_boss_event", {
    p_title: "E2E Boss",
    p_description: null,
    p_starts_at: starts.toISOString(),
    p_ends_at: new Date(Date.now() + 3_600_000).toISOString(),
    p_template: { hatedGenres: ["rock"], rewardItemId: "cd", hpPerPlayer: 400, maxHp: 99999 },
  }),
  "event",
);
log("event", event, "starts", starts.toISOString());

// --- Into the cave with real tickets.
async function ticket(p) {
  const r = await fetch(`${URL}/functions/v1/town-ticket?map=bossroom`, {
    headers: { authorization: `Bearer ${p.token}`, apikey: ANON },
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`ticket ${p.tag}: ${r.status} ${JSON.stringify(body)}`);
  return body;
}
function connect(p, at) {
  return new Promise(async (resolve, reject) => {
    const t = await ticket(p);
    const base = t.url.replace(/^http/, "ws");
    const ws = new WebSocket(`${base}/v1/town/bossroom?shard=0`);
    ws.binaryType = "arraybuffer";
    p.ws = ws;
    p.msgs = [];
    p.at = at;
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      const m = JSON.parse(e.data);
      p.msgs.push(m);
      if (m.t === "welcome") {
        p.you = m.you;
        resolve(p);
      }
      if (m.t === "bossAt") p.boss = m;
      if (["down", "out", "revived", "victory", "closing", "skillDenied", "channel", "raid"].includes(m.t))
        log(p.tag, "<", JSON.stringify(m).slice(0, 140));
    };
    ws.onclose = (e) => log(p.tag, "closed", e.code, e.reason);
    ws.onerror = (e) => reject(e);
    ws.onopen = () =>
      ws.send(JSON.stringify({ t: "hello", v: net.TOWN_PROTOCOL, ticket: t.ticket, at: { x: at.x, z: at.z, heading: Math.PI, speed: 0, flags: 0 } }));
  });
}
let seq = 0;
const stand = (p) => p.ws.readyState === 1 && p.ws.send(net.encodeStateFrame(++seq, { x: p.at.x, z: p.at.z, heading: Math.PI, speed: 0, flags: 0 }));
await connect(A, { x: 0, z: 10 });
await connect(B, { x: 1, z: 10 });
await connect(C, { x: -1, z: 10 });
log("all three in the lobby");
const heartbeat = setInterval(() => [A, B, C].forEach(stand), 200);

// --- Wait for the lock, then the knock-outs (B and C have 1 HP).
const waitFor = async (p, pred, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (p.msgs.some(pred)) return true;
    await sleep(100);
  }
  throw new Error(`timed out: ${what}`);
};
await waitFor(A, (m) => m.t === "raid" && m.stage === "fight", 45_000, "lock");
await waitFor(B, (m) => m.t === "down", 30_000, "B down");
await waitFor(C, (m) => m.t === "down", 30_000, "C down");

// C gives up (and respawns in town, as the app does).
C.ws.send(JSON.stringify({ t: "forfeit" }));
await fetch(`${URL}/functions/v1/town-vitals`, {
  method: "POST",
  headers: { authorization: `Bearer ${C.token}`, apikey: ANON, "content-type": "application/json" },
  body: JSON.stringify({ action: "respawn" }),
});
C.ws.close();

// A resurrects B: stand still next to B (A is 1 m away), play it.
A.ws.send(JSON.stringify({ t: "skill", skill: "resurrect", seq: 1, yaw: 0, pitch: 0 }));
await waitFor(A, (m) => m.t === "revived", 8_000, "revive");
await sleep(2_500); // a report or two

// A fells the boss: waves at it until it's down.
const aimFrom = (p) => {
  const b = p.boss ?? { x: 0, z: -4 };
  const dx = b.x - p.at.x;
  const dz = b.z - p.at.z;
  return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(2.4 - 1.2, Math.hypot(dx, dz)) };
};
for (let i = 0; i < 400 && !A.msgs.some((m) => m.t === "victory"); i++) {
  const { yaw, pitch } = aimFrom(A);
  A.ws.send(net.encodeCastFrame({ seq: i, yaw, pitch }));
  await sleep(450);
}
await waitFor(A, (m) => m.t === "victory", 5_000, "victory");
await sleep(6_000); // the killing report, settle, results, log
clearInterval(heartbeat);

// --- What the database says.
const state = must(await admin.from("boss_state").select("*").eq("event_id", event).single(), "state");
const parts = must(await admin.from("boss_participants").select("user_id,status").eq("event_id", event), "parts");
const drops = must(await admin.from("pending_drops").select("user_id").eq("source_event", event), "drops");
const logRow = must(await admin.from("boss_fight_log").select("*").eq("event_id", event), "log");
const name = (uid) => [A, B, C].find((p) => p.uid === uid)?.tag;
const count = (uid) => drops.filter((d) => d.user_id === uid).length;
console.log("\n=== database");
console.log("locked_at", state.locked_at, "max_hp", state.max_hp, "(expected", Math.round(400 * 3 ** 0.9), ") killed", state.killed, "revives", state.revives, "settled", state.settled);
console.log("participants", parts.map((p) => `${name(p.user_id)}:${p.status}`).join(" "));
console.log("drops A", count(A.uid), "B", count(B.uid), "C", count(C.uid));
console.log("fight log rows", logRow.length, logRow[0] ? JSON.stringify({ roster: logRow[0].roster_size, outcome: logRow[0].outcome, stats: logRow[0].stats }) : "");
for (const p of [A, B]) p.ws.close();
process.exit(0);
