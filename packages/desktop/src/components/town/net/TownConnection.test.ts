import {
  decodeStateFrame,
  encodeSnapshot,
  TOWN_CLOSE,
  TOWN_MAPS,
  TOWN_TICK_MS,
  TOWN_WALK_SPEED,
  type TownState,
} from "@herzies/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALK_SPEED } from "../animation";
import { HOME_MAP, WORLD_RADIUS } from "../runtime";
import { socketBase, TownConnection } from "./TownConnection";

/** Just enough of a browser WebSocket to drive the connection. */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: Array<string | ArrayBuffer> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string | ArrayBuffer) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" ? data : data });
  }
  json(m: unknown) {
    this.receive(JSON.stringify(m));
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  get states() {
    return this.sent
      .filter((d): d is ArrayBuffer => typeof d !== "string")
      .map((d) => decodeStateFrame(d)?.state);
  }
}

const ticket = { ticket: "t", url: "wss://town.test", exp: 1e12 };

function setup(state: Partial<TownState> = {}) {
  const here: TownState = {
    x: 1,
    z: 2,
    heading: 0,
    speed: 0,
    flags: 0,
    ...state,
  };
  const corrections: Array<[number, number]> = [];
  const getTicket = vi.fn(async () => ticket);
  const conn = new TownConnection({
    map: "home",
    getTicket,
    readState: () => here,
    onCorrect: (x, z) => corrections.push([x, z]),
  });
  return { conn, here, corrections, getTicket };
}

/** Lets the ticket promise settle and the socket get created. */
const settle = () => vi.advanceTimersByTimeAsync(0);
const latest = () => FakeSocket.all[FakeSocket.all.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TownConnection", () => {
  it("says hello with where the herzie is, and goes online on welcome", async () => {
    const { conn } = setup();
    conn.start();
    await settle();
    const ws = latest();
    expect(ws.url).toBe("wss://town.test/v1/town/home?shard=0");
    expect(ws.binaryType).toBe("arraybuffer");
    ws.open();
    const hello = JSON.parse(ws.sent[0] as string);
    expect(hello).toMatchObject({
      t: "hello",
      ticket: "t",
      at: { x: 1, z: 2 },
    });
    ws.json({
      t: "welcome",
      you: 7,
      players: [{ id: 3, name: "eddie", look: { seed: "s", stage: 1 } }],
    });
    expect(conn.status).toBe("online");
    expect([...conn.remotes.keys()]).toEqual([3]);
  });

  it("sends movement only when it changes", async () => {
    const { conn, here } = setup();
    conn.start();
    await settle();
    latest().open();
    latest().json({ t: "welcome", you: 1, players: [] });
    await vi.advanceTimersByTimeAsync(TOWN_TICK_MS * 10);
    expect(latest().states.length).toBe(1);
    here.x = 1.5;
    here.speed = 4.5;
    await vi.advanceTimersByTimeAsync(TOWN_TICK_MS);
    expect(latest().states.at(-1)).toMatchObject({ x: 1.5, speed: 4.5 });
    expect(latest().states.length).toBe(2);
  });

  it("feeds snapshots to other players' buffers, not its own", async () => {
    const { conn } = setup();
    conn.start();
    await settle();
    latest().open();
    latest().json({
      t: "welcome",
      you: 1,
      players: [{ id: 2, name: "b", look: { seed: "s", stage: 1 } }],
    });
    const at = (x: number): TownState => ({
      x,
      z: 0,
      heading: 0,
      speed: 0,
      flags: 0,
    });
    latest().receive(
      encodeSnapshot(5000, [
        { id: 1, age: 0, state: at(9) },
        { id: 2, age: 0, state: at(3) },
      ]),
    );
    expect(conn.remotes.get(2)?.buffer.sample(5000)?.x).toBe(3);
    expect(conn.remotes.has(1)).toBe(false);
  });

  it("moves to the next shard when a room is full", async () => {
    const { conn } = setup();
    conn.start();
    await settle();
    latest().drop(TOWN_CLOSE.full);
    await vi.advanceTimersByTimeAsync(1);
    expect(latest().url).toContain("shard=1");
  });

  it("gives up on an outdated app, and on being replaced", async () => {
    const a = setup();
    a.conn.start();
    await settle();
    latest().drop(TOWN_CLOSE.outdated);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.conn.status).toBe("outdated");
    expect(FakeSocket.all.length).toBe(1);

    const b = setup();
    b.conn.start();
    await settle();
    latest().drop(TOWN_CLOSE.replaced);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.conn.status).toBe("replaced");
    expect(FakeSocket.all.length).toBe(2);
  });

  it("reconnects with a fresh ticket after an auth failure", async () => {
    const { conn, getTicket } = setup();
    conn.start();
    await settle();
    latest().drop(TOWN_CLOSE.auth);
    await vi.advanceTimersByTimeAsync(BACKOFF_CEILING);
    expect(getTicket).toHaveBeenCalledTimes(2);
    expect(FakeSocket.all.length).toBe(2);
  });

  it("stays off when multiplayer is switched off", async () => {
    const { conn, getTicket } = setup();
    getTicket.mockRejectedValue("off");
    conn.start();
    await settle();
    expect(conn.status).toBe("off");
    expect(FakeSocket.all.length).toBe(0);
  });

  it("drops a connection that went silent and reconnects", async () => {
    const { conn } = setup();
    conn.start();
    await settle();
    latest().open();
    latest().json({ t: "welcome", you: 1, players: [] });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(FakeSocket.all.length).toBeGreaterThan(1);
  });

  it("passes on the server's corrections", async () => {
    const { conn, corrections } = setup();
    conn.start();
    await settle();
    latest().open();
    latest().json({ t: "welcome", you: 1, players: [] });
    latest().json({ t: "correct", x: 4, z: 5 });
    expect(corrections).toEqual([[4, 5]]);
  });
});

/** The first retry is never later than this. */
const BACKOFF_CEILING = 1_000;

describe("the server's idea of the Town matches the app's", () => {
  it("agrees on the walkable radius, spawn and walking speed", () => {
    expect(TOWN_MAPS.home.radius).toBe(WORLD_RADIUS);
    expect([TOWN_MAPS.home.spawn.x, TOWN_MAPS.home.spawn.z]).toEqual(
      HOME_MAP.spawn.at,
    );
    expect(TOWN_WALK_SPEED).toBe(WALK_SPEED);
  });
});

describe("socketBase", () => {
  it("makes a WebSocket URL of whatever the server's config says", () => {
    expect(socketBase("wss://t.dev/")).toBe("wss://t.dev");
    expect(socketBase("https://t.dev")).toBe("wss://t.dev");
    expect(socketBase("http://localhost:8787")).toBe("ws://localhost:8787");
    expect(socketBase("herzies-town.novasism.workers.dev")).toBe(
      "wss://herzies-town.novasism.workers.dev",
    );
  });
});
