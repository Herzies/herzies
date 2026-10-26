/**
 * The boss room through a real Durable Object: who gets in, what a
 * newcomer is told, and a cast reaching the boss. One shard for the whole
 * file, as in production (a single shared fight), so the tests below build
 * on each other in order.
 */
import {
  encodeCastFrame,
  type ServerMessage,
  signTownTicket,
  TOWN_CLOSE,
  TOWN_PROTOCOL,
  type TownTicketPayload,
} from "@herzies/shared/town-net";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TUNING } from "../src/boss";

const SECRET = "test-secret";

async function connect() {
  const res = await exports.default.fetch(
    "https://town.test/v1/town/bossroom?shard=0",
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
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (e) => resolve(e.code)),
  );
  const next = async <T extends ServerMessage["t"]>(t: T) => {
    for (let i = 0; i < 200; i++) {
      const idx = messages.findIndex((m) => m.t === t);
      if (idx >= 0)
        return messages.splice(idx, 1)[0] as Extract<ServerMessage, { t: T }>;
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
    throw new Error(`no ${t} message`);
  };
  return { ws, messages, closed, next };
}

function ticket(uid: string, over: Partial<TownTicketPayload> = {}) {
  return signTownTicket(
    {
      uid,
      name: uid,
      look: { seed: `HERZ-${uid}`, stage: 2 },
      // A wave caster: these casts are from across the room.
      cls: "bard",
      exp: Date.now() / 1000 + 600,
      hp: { hp: 200, maxHp: 200, down: false },
      st: [0, 0, 0, 0],
      boss: {
        event: "evt-room-test",
        until: Date.now() / 1000 + 600,
        hp: 50_000,
        maxHp: 50_000,
      },
      ...over,
    },
    SECRET,
  );
}

async function enter(uid: string, over: Partial<TownTicketPayload> = {}) {
  const c = await connect();
  c.ws.send(
    JSON.stringify({
      t: "hello",
      v: TOWN_PROTOCOL,
      ticket: await ticket(uid, over),
      at: { x: 0, z: 10, heading: 0, speed: 0, flags: 0 },
    }),
  );
  return c;
}

describe("boss room", () => {
  it("turns away a ticket with no boss claim", async () => {
    const c = await enter("nobody", { boss: undefined });
    expect(await c.closed).toBe(TOWN_CLOSE.sealed);
  });

  it("turns away a knocked-out herzie", async () => {
    const c = await enter("fallen", {
      hp: { hp: 0, maxHp: 200, down: true },
    });
    expect(await c.closed).toBe(TOWN_CLOSE.sealed);
  });

  it("turns away a ticket issued too long ago, since its health is stale", async () => {
    const c = await enter("stale", {
      // Still valid for five minutes, so issued five minutes ago (a ticket
      // lasts ten): too old to trust its health.
      exp: Date.now() / 1000 + 300,
    });
    expect(await c.closed).toBe(TOWN_CLOSE.auth);
  });

  it("turns away a boss that has already left", async () => {
    const c = await enter("late", {
      boss: {
        event: "evt-room-test",
        until: Date.now() / 1000 - 5,
        hp: 1,
        maxHp: 1,
      },
    });
    expect(await c.closed).toBe(TOWN_CLOSE.sealed);
  });

  it("welcomes a newcomer with the fight as it stands", async () => {
    const a = await enter("alice");
    const w = await a.next("welcome");
    expect(w.fight).toMatchObject({
      hp: 50_000,
      maxHp: 50_000,
      phase: 1,
    });
    expect(w.fight?.health).toEqual([{ id: w.you, hp: 200, maxHp: 200 }]);
    a.ws.close();
    await a.closed;
  });

  it("won't let a herzie at full health eat, and ignores a malformed eat", async () => {
    const c = await enter("snacker");
    await c.next("welcome");
    c.ws.send(JSON.stringify({ t: "eat", item: 5, seq: "x" }));
    c.ws.send(JSON.stringify({ t: "eat", item: "star-candy", seq: 1 }));
    expect(await c.next("ate")).toEqual({
      t: "ate",
      seq: 1,
      item: "star-candy",
      ok: false,
      reason: "full",
    });
    c.ws.close();
    await c.closed;
  });

  it("tells the room when a cast hits the boss, and the caster by how much", async () => {
    const a = await enter("caster");
    const wa = await a.next("welcome");
    const b = await enter("watcher");
    await b.next("welcome");
    await a.next("hp"); // watcher's bar
    // From the spawn point at (0, 10), straight at the boss's chest.
    const dz = TUNING.boss.z - 10;
    a.ws.send(
      encodeCastFrame({
        seq: 1,
        yaw: Math.atan2(0, dz),
        pitch: Math.atan2(TUNING.boss.chest - 1.2, Math.abs(dz)),
      }),
    );
    const hit = await a.next("hit");
    expect(hit.damage).toBeGreaterThan(80);
    const boss = await b.next("boss");
    expect(boss.hp).toBeLessThan(50_000);
    expect(boss.maxHp).toBe(50_000);
    expect(wa.you).toBeGreaterThan(0);
    a.ws.close();
    await a.closed;
    b.ws.close();
    await b.closed;
  });

  it("ignores a cast aimed away from the boss", async () => {
    const a = await enter("wild");
    await a.next("welcome");
    a.ws.send(encodeCastFrame({ seq: 1, yaw: 0, pitch: 0 }));
    await new Promise((r) => setTimeout(r, 900));
    expect(a.messages.find((m) => m.t === "hit")).toBeUndefined();
    a.ws.close();
    await a.closed;
  });

  it("turns away a ticket for a different boss while a fight is on", async () => {
    const holder = await enter("holder");
    await holder.next("welcome");
    const c = await enter("other", {
      boss: {
        event: "some-other-boss",
        until: Date.now() / 1000 + 600,
        hp: 10,
        maxHp: 10,
      },
    });
    expect(await c.closed).toBe(TOWN_CLOSE.closed);
    holder.ws.close();
    await holder.closed;
  });

  it("gives a new boss a fresh fight once the room is empty", async () => {
    await new Promise((r) => setTimeout(r, 100));
    const c = await enter("next-boss-fan", {
      boss: {
        event: "the-next-boss",
        until: Date.now() / 1000 + 600,
        hp: 777,
        maxHp: 1000,
      },
    });
    const w = await c.next("welcome");
    expect(w.fight).toMatchObject({ event: "the-next-boss", hp: 777, maxHp: 1000 });
    c.ws.close();
    await c.closed;
  });

  describe("a locked raid", () => {
    const raidClaim = () => ({
      event: "evt-raid-room",
      until: Date.now() / 1000 + 600,
      hp: 20_000,
      maxHp: 20_000,
      starts: Date.now() / 1000 - 60,
      locked: {
        at: Date.now() / 1000 - 60,
        roster: ["r-standing", "r-down"],
        revives: 0,
      },
    });

    it("lets a roster member in, and turns away anyone else", async () => {
      await new Promise((r) => setTimeout(r, 100));
      const a = await enter("r-standing", { boss: raidClaim() });
      const w = await a.next("welcome");
      expect(w.fight?.raid).toMatchObject({ stage: "fight", you: "in" });
      const c = await enter("r-outsider", { boss: raidClaim() });
      expect(await c.closed).toBe(TOWN_CLOSE.sealed);
      a.ws.close();
      await a.closed;
    });

    it("lets a downed roster member back in to wait for a Bard, and give up", async () => {
      const keeper = await enter("r-standing", { boss: raidClaim() });
      await keeper.next("welcome");
      const d = await enter("r-down", {
        boss: raidClaim(),
        hp: { hp: 0, maxHp: 200, down: true },
      });
      await d.next("welcome");
      await d.next("down");
      d.ws.send(JSON.stringify({ t: "forfeit" }));
      await d.next("out");
      d.ws.close();
      await d.closed;
      keeper.ws.close();
      await keeper.closed;
    });
  });
});
