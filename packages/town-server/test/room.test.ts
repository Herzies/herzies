import {
  decodeSnapshot,
  encodeStateFrame,
  type ServerMessage,
  signTownTicket,
  TOWN_CLOSE,
  TOWN_PROTOCOL,
  type TownState,
} from "@herzies/shared/town-net";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { checkMove, newGuard, RateLimiter } from "../src/rules";

const SECRET = "test-secret";
let shardSeq = 0;

const at = (x: number, z: number, speed = 0): TownState => ({
  x,
  z,
  heading: 0,
  speed,
  flags: 0,
});

type Client = {
  ws: WebSocket;
  messages: ServerMessage[];
  snapshots: NonNullable<ReturnType<typeof decodeSnapshot>>[];
  closed: Promise<number>;
  next: (t: ServerMessage["t"]) => Promise<ServerMessage>;
};

async function connect(shard: number): Promise<Client> {
  const res = await exports.default.fetch(
    `https://town.test/v1/town/home?shard=${shard}`,
    { headers: { upgrade: "websocket" } },
  );
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket: ${res.status}`);
  ws.accept();
  // workerd hands client-side binary frames over as Blobs by default.
  (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
  const messages: ServerMessage[] = [];
  const snapshots: Client["snapshots"] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") messages.push(JSON.parse(e.data));
    else {
      const s = decodeSnapshot(e.data as ArrayBuffer);
      if (s) snapshots.push(s);
    }
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (e) => resolve(e.code)),
  );
  const next = async (t: ServerMessage["t"]) => {
    for (let i = 0; i < 100; i++) {
      const idx = messages.findIndex((m) => m.t === t);
      if (idx >= 0) return messages.splice(idx, 1)[0];
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
    throw new Error(`no ${t} message`);
  };
  return { ws, messages, snapshots, closed, next };
}

async function ticket(uid: string, name = uid, exp = Date.now() / 1000 + 600) {
  return signTownTicket(
    { uid, name, look: { seed: `HERZ-${uid}`, stage: 1 }, exp },
    SECRET,
  );
}

async function join(shard: number, uid: string, pos = at(0, 0)) {
  const c = await connect(shard);
  c.ws.send(
    JSON.stringify({ t: "hello", v: TOWN_PROTOCOL, ticket: await ticket(uid), at: pos }),
  );
  const welcome = await c.next("welcome");
  return { ...c, id: (welcome as { you: number }).you, welcome };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("rules", () => {
  it("allows walking and refuses running", () => {
    const g = newGuard(0, 0, 0);
    let x = 0;
    for (let t = 66; t < 3000; t += 66) {
      x += 4.5 * 0.066;
      expect(checkMove(g, x, 0, t, "home")).toBe(true);
    }
    const r = newGuard(0, -20, 0);
    let z = -20;
    let refused = false;
    for (let t = 66; t < 3000; t += 66) {
      z += 15 * 0.066;
      if (!checkMove(r, 0, z, t, "home")) refused = true;
    }
    expect(refused).toBe(true);
  });

  it("allows a jump back to the spawn point, but nowhere else", () => {
    const g = newGuard(30, 0, 0);
    expect(checkMove(g, -30, 0, 100, "home")).toBe(false);
    expect(checkMove(g, 0, 10, 100, "home")).toBe(true);
  });

  it("refuses leaving the island", () => {
    const g = newGuard(39.9, 0, 0);
    expect(checkMove(g, 41, 0, 1000, "home")).toBe(false);
  });

  it("rate-limits bursts", () => {
    const l = new RateLimiter(10, 5, 0);
    const ok = Array.from({ length: 8 }, () => l.take(0)).filter(Boolean);
    expect(ok.length).toBe(5);
    expect(l.take(100)).toBe(true);
  });
});

describe("room", () => {
  it("refuses a bad ticket and an outdated client", async () => {
    const shard = ++shardSeq;
    const bad = await connect(shard);
    bad.ws.send(JSON.stringify({ t: "hello", v: TOWN_PROTOCOL, ticket: "x.y", at: at(0, 0) }));
    expect(await bad.closed).toBe(TOWN_CLOSE.auth);

    const expired = await connect(shard);
    expired.ws.send(
      JSON.stringify({
        t: "hello",
        v: TOWN_PROTOCOL,
        ticket: await ticket("e", "e", Date.now() / 1000 - 1),
        at: at(0, 0),
      }),
    );
    expect(await expired.closed).toBe(TOWN_CLOSE.auth);

    const old = await connect(shard);
    old.ws.send(JSON.stringify({ t: "hello", v: 0, ticket: await ticket("o") }));
    expect(await old.closed).toBe(TOWN_CLOSE.outdated);
  });

  it("refuses movement before hello", async () => {
    const c = await connect(++shardSeq);
    c.ws.send(encodeStateFrame(0, at(1, 1)));
    expect(await c.closed).toBe(TOWN_CLOSE.auth);
  });

  it("introduces players to each other and relays movement", async () => {
    const shard = ++shardSeq;
    const a = await join(shard, "a", at(1, 2));
    expect((a.welcome as { players: unknown[] }).players).toEqual([]);

    const b = await join(shard, "b", at(3, 4));
    const others = (b.welcome as { players: { id: number; name: string }[] })
      .players;
    expect(others.map((p) => p.name)).toEqual(["a"]);
    // The newcomer gets a full snapshot of who's where.
    await sleep(50);
    expect(b.snapshots[0]?.entries[0]).toMatchObject({
      id: a.id,
      state: { x: 1, z: 2 },
    });
    const joined = (await a.next("join")) as { player: { id: number } };
    expect(joined.player.id).toBe(b.id);

    a.ws.send(encodeStateFrame(1, at(1.2, 2, 4.5)));
    await sleep(200);
    const seen = b.snapshots
      .flatMap((s) => s.entries)
      .filter((e) => e.id === a.id);
    expect(seen.at(-1)?.state).toMatchObject({ x: 1.2, z: 2, speed: 4.5 });

    a.ws.close(1000);
    const left = (await b.next("leave")) as { id: number };
    expect(left.id).toBe(a.id);
  });

  it("corrects an impossible move", async () => {
    const a = await join(++shardSeq, "a", at(0, 0));
    a.ws.send(encodeStateFrame(1, at(25, 0, 4.5)));
    expect(await a.next("correct")).toMatchObject({ x: 0, z: 0 });
  });

  it("lets a reconnecting herzie keep its place", async () => {
    const shard = ++shardSeq;
    const watcher = await join(shard, "w");
    const first = await join(shard, "same");
    await watcher.next("join");
    const second = await join(shard, "same");
    expect(await first.closed).toBe(TOWN_CLOSE.replaced);
    expect(second.id).toBe(first.id);
    // Watchers see it carry on, not leave and come back.
    await watcher.next("look");
    expect(watcher.messages.some((m) => m.t === "leave")).toBe(false);
  });

  it("turns newcomers away from a full room", async () => {
    const shard = ++shardSeq;
    await join(shard, "1");
    await join(shard, "2");
    await join(shard, "3");
    const fourth = await connect(shard);
    expect(await fourth.closed).toBe(TOWN_CLOSE.full);
  });

  it("broadcasts a look change from a renewed ticket", async () => {
    const shard = ++shardSeq;
    const a = await join(shard, "a");
    const b = await join(shard, "b");
    await a.next("join");
    b.ws.send(JSON.stringify({ t: "ticket", ticket: await ticket("b", "renamed") }));
    const look = (await a.next("look")) as { player: { name: string } };
    expect(look.player.name).toBe("renamed");
  });

  it("refuses someone else's ticket as a renewal", async () => {
    const a = await join(++shardSeq, "a");
    a.ws.send(JSON.stringify({ t: "ticket", ticket: await ticket("mallory") }));
    expect(await a.closed).toBe(TOWN_CLOSE.auth);
  });

  it("kicks a flooding client", async () => {
    const a = await join(++shardSeq, "a");
    for (let i = 0; i < 400; i++) a.ws.send("{}");
    expect(await a.closed).toBe(TOWN_CLOSE.kicked);
  });
});

describe("worker", () => {
  it("routes only known maps and websockets", async () => {
    const f = (path: string, init?: RequestInit) =>
      exports.default.fetch(`https://town.test${path}`, init);
    expect((await f("/health")).status).toBe(200);
    expect((await f("/v1/town/home")).status).toBe(426);
    expect(
      (await f("/v1/town/moon", { headers: { upgrade: "websocket" } })).status,
    ).toBe(404);
    expect(
      (await f("/v1/town/home?shard=99", { headers: { upgrade: "websocket" } }))
        .status,
    ).toBe(400);
  });
});
