// A knocked-out herzie in Town, right in front of you, for trying a Bard's
// Resurrect outside a fight. It lies where it fell; once you bring it back
// it waits a few seconds and falls down again, so you can try it again.
//
//   ANON_KEY=… SERVICE_ROLE_KEY=… node down-bot.mjs [YOUR_HERZIE_NAME]
import { createRequire } from "node:module";

const ROOT = new globalThis.URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const require = createRequire(`${ROOT}/packages/web/package.json`);
const { createClient } = require("@supabase/supabase-js");
const net = await import(`${ROOT}/packages/shared/dist/town-net.js`);

const YOU = process.argv[2] ?? "yoyomr";
const URL = "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const SERVICE = process.env.SERVICE_ROLE_KEY;
if (!ANON || !SERVICE) throw new Error("ANON_KEY / SERVICE_ROLE_KEY");
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const REDOWN_MS = 8_000;

// --- Floppy, made once and reused.
const email = "bot-floppy@herzies.test";
const password = "bot-password-123";
const anon = createClient(URL, ANON, { auth: { persistSession: true } });
let { data: s } = await anon.auth.signInWithPassword({ email, password });
if (!s?.session) {
  await admin.auth.admin.createUser({ email, password, email_confirm: true });
  ({ data: s } = await anon.auth.signInWithPassword({ email, password }));
}
const uid = s.user.id;
const { data: had } = await admin.from("herzies").select("user_id").eq("user_id", uid).maybeSingle();
if (!had) {
  const { error } = await admin.from("herzies").insert({
    user_id: uid,
    name: "Floppy",
    friend_code: `HERZ-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    appearance: { headIndex: 2, eyesIndex: 1, mouthIndex: 3, accessoryIndex: 0, limbsIndex: 1, bodyIndex: 2, legsIndex: 0, colorScheme: "pink" },
    xp: 0, level: 15, stage: 2, total_minutes_listened: 0, genre_minutes: {}, friend_codes: [], currency: 0,
  });
  if (error) throw error;
}

async function knockOut() {
  const { error } = await admin
    .from("herzies")
    .update({ hp: 0, hp_at: new Date().toISOString(), down: true })
    .eq("user_id", uid);
  if (error) throw error;
}
async function ticket() {
  const { data } = await anon.auth.getSession();
  const r = await fetch(`${URL}/functions/v1/town-ticket?map=home`, {
    headers: { authorization: `Bearer ${data.session.access_token}`, apikey: ANON },
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`ticket: ${r.status} ${JSON.stringify(body)}`);
  return body;
}

/** Into Town's home island at `at`; resolves with the socket once in. */
function connect(at, onMessage) {
  return new Promise(async (resolve, reject) => {
    const t = await ticket();
    const ws = new WebSocket(`${t.url.replace(/^http/, "ws")}/v1/town/home?shard=0`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => onMessage(ws, e.data, resolve);
    ws.onerror = reject;
    ws.onopen = () =>
      ws.send(JSON.stringify({ t: "hello", v: net.TOWN_PROTOCOL, ticket: t.ticket, at: { ...at, speed: 0, flags: 0 } }));
  });
}

await knockOut();

// First, a look round for you: where you stand and which way you face.
// Waits (reconnecting if the room lets the socket go) until you're there.
let youId = null;
let youAt = null;
async function findYou() {
  for (;;) {
    const found = await new Promise(async (done) => {
      const t = await ticket();
      const ws = new WebSocket(`${t.url.replace(/^http/, "ws")}/v1/town/home?shard=0`);
      ws.binaryType = "arraybuffer";
      const keep = setInterval(() => ws.readyState === 1 && ws.send(net.TOWN_PING), 10_000);
      const finish = (v) => {
        clearInterval(keep);
        ws.onclose = null;
        ws.close();
        done(v);
      };
      ws.onopen = () =>
        ws.send(JSON.stringify({ t: "hello", v: net.TOWN_PROTOCOL, ticket: t.ticket, at: { x: 13.5, z: 12, heading: 0, speed: 0, flags: 0 } }));
      ws.onclose = () => {
        clearInterval(keep);
        done(false);
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") {
          const snap = net.decodeSnapshot(e.data);
          for (const en of snap?.entries ?? []) if (en.id === youId) youAt = en.state;
          if (youAt) finish(true);
          return;
        }
        if (e.data === net.TOWN_PONG) return;
        const m = JSON.parse(e.data);
        if (m.t === "welcome") {
          youId = m.players.find((p) => p.name === YOU)?.id ?? null;
          if (youId === null) log(`waiting for ${YOU} to come into Town…`);
        }
        if ((m.t === "join" || m.t === "look") && m.player.name === YOU) youId = m.player.id;
      };
    });
    if (found) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
await findYou();
const spot = {
  x: youAt.x + Math.sin(youAt.heading) * 2.2,
  z: youAt.z + Math.cos(youAt.heading) * 2.2,
  heading: youAt.heading + Math.PI,
};
log(`${YOU} is at (${youAt.x.toFixed(1)}, ${youAt.z.toFixed(1)}): Floppy falls in front of you`);

let meId = null;
const ws = await connect(spot, (ws, data, resolve) => {
  if (typeof data !== "string") return;
  if (data === net.TOWN_PONG) return;
  const m = JSON.parse(data);
  if (m.t === "welcome") {
    meId = m.you;
    log("Floppy is down in front of you. Press your Resurrect key (2) next to it.");
    resolve(ws);
  }
  if (m.t === "channel" && m.target === meId) log("…a Bard is playing Floppy back up");
  if (m.t === "channel" && m.target === null) log("…the resurrect stopped short");
  if (m.t === "revived" && m.id === meId) {
    log(`Floppy is back up! It falls down again in ${REDOWN_MS / 1000}s.`);
    setTimeout(async () => {
      await knockOut();
      const t = await ticket();
      ws.send(JSON.stringify({ t: "ticket", ticket: t.ticket }));
      log("Floppy is down again.");
    }, REDOWN_MS);
  }
});
ws.onclose = (e) => {
  log(`disconnected (${e.code} ${e.reason})`);
  process.exit(0);
};
// Stay in: a ping now and then, and a fresh ticket before it runs out.
setInterval(() => ws.readyState === 1 && ws.send(net.TOWN_PING), 20_000);
setInterval(async () => {
  const t = await ticket();
  ws.send(JSON.stringify({ t: "ticket", ticket: t.ticket }));
}, 5 * 60_000);
