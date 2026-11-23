/**
 * The Wilds' free-for-all through a real Durable Object: two herzies out
 * of the camp, protected on arrival, one hits the other once that's over,
 * the other leaves mid-fight (the hitter gets the line) and comes back
 * still down; one back on a new socket (a hidden window shown again) only
 * has what's left of its protection. No duels here. The room keeps its own
 * clock, so this waits out the real protection (5 s). And its loot: a
 * newcomer's snapshot of the cache that's out (its shard's own, kept over
 * a sleep), the crystal hearing who's playing music, the room
 * seeing who's holding it, and what's refused without a database (no
 * TOWN_VITALS_URL in tests).
 */
import { HERZIE_BODY, WAVE_HAND_HEIGHT } from "@herzies/shared/combat";
import {
  encodeCastFrame,
  type ServerMessage,
  signTownTicket,
  TOWN_PROTOCOL,
} from "@herzies/shared/town-net";
import { wildsCacheId, wildsCacheSpot } from "@herzies/shared/wilds-loot";
import { WILDS_PVP, wildsMaxHp } from "@herzies/shared/wilds-pvp";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { realTicket } from "./herzies";

const SECRET = "test-secret";

async function connect(shard: number) {
  const res = await exports.default.fetch(
    `https://town.test/v1/town/wilds?shard=${shard}`,
    { headers: { upgrade: "websocket" } },
  );
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket: ${res.status}`);
  ws.accept();
  (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
  const messages: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") messages.push(JSON.parse(e.data));
    for (const w of waiters.splice(0)) w();
  });
  const next = async <T extends ServerMessage["t"]>(
    t: T,
    where: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true,
  ) => {
    for (let i = 0; i < 200; i++) {
      const idx = messages.findIndex(
        (m) => m.t === t && where(m as Extract<ServerMessage, { t: T }>),
      );
      if (idx >= 0)
        return messages.splice(idx, 1)[0] as Extract<ServerMessage, { t: T }>;
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
    throw new Error(`no ${t} message`);
  };
  return { ws, messages, next };
}

async function join(
  shard: number,
  uid: string,
  x: number,
  z = 0,
  wilds?: { event: string; startsAt: number; endsAt: number },
) {
  const c = await connect(shard);
  c.ws.send(
    JSON.stringify({
      t: "hello",
      v: TOWN_PROTOCOL,
      ticket: await signTownTicket(
        { ...realTicket(uid, "bard", 20), ...(wilds ? { wilds } : {}) },
        SECRET,
      ),
      at: { x, z, heading: 0, speed: 0, flags: 0 },
    }),
  );
  const welcome = await c.next("welcome");
  return { ...c, id: welcome.you, welcome };
}

const send = (ws: WebSocket, m: unknown) => ws.send(JSON.stringify(m));
const A = 30;
const B = 34;

describe("the Wilds' free-for-all in a room", () => {
  it("protects, judges a hit, and credits a leaver's last hitter", async () => {
    const a = await join(1, "wild-a", A);
    const b = await join(1, "wild-b", B);
    const max = wildsMaxHp(20);
    // Each arrival is protected, and everyone hears so.
    const shieldA = await a.next("pvp", (m) => m.id === a.id);
    expect(shieldA).toMatchObject({ hp: max, maxHp: max });
    expect(shieldA.shield).toBeGreaterThan(Date.now());
    expect(await b.next("pvp", (m) => m.id === a.id)).toMatchObject({
      shield: shieldA.shield,
    });
    const shieldB = await a.next("pvp", (m) => m.id === b.id);

    // No duels in the Wilds.
    send(a.ws, { t: "duel", op: "ask", to: b.id });
    expect(await a.next("duelNo")).toMatchObject({ with: b.id, why: "here" });

    // Once b's protection is over, a's wave at it lands. (A real wait: the
    // Durable Object runs on its own clock, out of reach of fake timers.)
    await new Promise((r) =>
      setTimeout(r, Math.max(0, (shieldB.shield ?? 0) - Date.now() + 100)),
    );
    a.ws.send(
      encodeCastFrame({
        seq: 1,
        yaw: Math.PI / 2,
        pitch: Math.atan2(HERZIE_BODY.chest - WAVE_HAND_HEIGHT, B - A),
      }),
    );
    const hit = await a.next("pvpHit");
    expect(hit.target).toBe(b.id);
    expect(hit.damage).toBeGreaterThan(0);
    expect(
      await b.next("pvp", (m) => m.id === b.id && m.hp < max),
    ).toMatchObject({ hp: max - hit.damage, by: a.id });

    // b leaves mid-fight: a gets the line.
    b.ws.close(1000);
    expect(await a.next("pvpFeed")).toEqual({
      t: "pvpFeed",
      by: a.id,
      byName: "wild-a",
      victim: b.id,
      victimName: "wild-b",
      logged: true,
    });

    // Back at once, it's still down (until its time is up).
    const back = await join(1, "wild-b", B);
    const down = await back.next("pvp", (m) => m.id === back.id);
    expect(down.hp).toBe(0);
    expect(down.down).toBeGreaterThan(Date.now());
    expect(down.down).toBeLessThanOrEqual(Date.now() + WILDS_PVP.respawnMs);
  }, 15_000);

  it("gives a herzie back on a new socket no fresh protection", async () => {
    // What hiding the app's window does: the socket goes, a new one says
    // hello when it's shown again.
    const a = await join(3, "hide-a", A);
    const c = await join(3, "hide-c", B);
    const first = await a.next("pvp", (m) => m.id === a.id);
    expect(first.shield).toBeGreaterThan(Date.now());
    a.ws.close(1000);
    await c.next("leave", (m) => m.id === a.id);
    const back = await join(3, "hide-a", A);
    expect(await back.next("pvp", (m) => m.id === back.id)).toMatchObject({
      shield: first.shield,
    });
    back.ws.close(1000);
    c.ws.close(1000);
  }, 15_000);

  it("shows a newcomer the cache that's out, and who's holding it", async () => {
    const now = Date.now();
    const claim = {
      event: "room-loot-event",
      startsAt: now - 30_000,
      endsAt: now + 60 * 60_000,
    };
    // The crystal was listened full before the room last slept: its cache
    // is out (kept in the room's storage).
    const spot = wildsCacheSpot(claim.event, 0);
    const cache = { id: wildsCacheId(claim.event, now - 1_000, 2), ...spot };
    const rooms = (env as unknown as { TOWN_ROOM: DurableObjectNamespace })
      .TOWN_ROOM;
    await runInDurableObject(
      rooms.get(rooms.idFromName("wilds:2")),
      (_room: unknown, state: DurableObjectState) => {
        state.storage.kv.put("hunt", {
          event: claim.event,
          charge: 1,
          k: 1,
          cache,
        });
      },
    );
    const a = await join(2, "loot-a", spot.x, spot.z, claim);
    expect(await a.next("wildsLoot")).toEqual({
      t: "wildsLoot",
      drops: [],
      cache,
      hold: null,
      hunt: expect.objectContaining({ charge: 1, rate: 0, listeners: 0 }),
    });
    // Playing music on the Wilds: counted (the crystal's full, so it
    // doesn't fill on).
    send(a.ws, { t: "tune", on: true });
    expect(await a.next("wildsHunt", (m) => m.hunt?.listeners === 1)).toEqual(
      {
        t: "wildsHunt",
        hunt: expect.objectContaining({ charge: 1, rate: 0 }),
      },
    );
    // Standing by it: the room sees a holding it, and says so.
    expect(await a.next("wildsHold")).toMatchObject({
      id: cache.id,
      holders: [{ id: a.id }],
      contested: false,
    });
    // At the spawn, well out of the ring: shown a's hold.
    const b = await join(2, "loot-b", Number.NaN, 0, claim);
    const seen = await b.next("wildsLoot");
    expect(seen.cache).toEqual(cache);
    expect(seen.hold?.holders.map((h) => h.id)).toEqual([a.id]);
    expect(seen.hold?.contested).toBe(false);
    send(a.ws, { t: "wildsTake", id: "no-such-drop" });
    expect(await a.next("wildsRefused")).toEqual({
      t: "wildsRefused",
      id: "no-such-drop",
      why: "gone",
    });
    a.ws.close(1000);
    b.ws.close(1000);
  }, 15_000);
});
