import type { LootDrop, ServerMessage } from "@herzies/shared/town-net";
import {
  huntRate,
  WILDS_CACHE_HOLD_MS,
  WILDS_CACHE_HOLD_RADIUS,
  WILDS_DROP,
  WILDS_HUNT_FILL_MS,
  wildsCacheId,
  wildsCacheSpot,
} from "@herzies/shared/wilds-loot";
import { describe, expect, it, vi } from "vitest";
import type { Outbound } from "../src/fight";
import type {
  WildsCacheReply,
  WildsLootDb,
  WildsTakeReply,
} from "../src/vitals";
import {
  HOLD_RETRY_MS,
  type HuntSaved,
  type WildsLootPeer,
  WildsLootRuntime,
} from "../src/wilds-loot";

const EVENT = "wilds-event-1";
const START = 10_000_000;
const END = START + 60 * 60_000;
const CLAIM = { event: EVENT, startsAt: START, endsAt: END };
const SHARD = 3;
/** Mid-event, before the first cache. */
const T = START + 10_000;
/** Where b fell. */
const FELL = { x: 30, z: 0 };
/** When a crystal listened full from T turns up its cache. */
const AT = T + WILDS_HUNT_FILL_MS;

type Msg<K extends ServerMessage["t"]> = Extract<ServerMessage, { t: K }>;

/** What was said of kind `t`: to the whole room, or to `to` alone. */
function said<K extends ServerMessage["t"]>(
  out: Outbound[],
  t: K,
  to?: string,
): Msg<K>[] {
  return out
    .filter(
      (o) =>
        o.msg.t === t &&
        (to === undefined ? o.to === "all" : o.to !== "all" && o.to.uid === to),
    )
    .map((o) => o.msg as Msg<K>);
}

function deferred<V>() {
  let resolve!: (v: V) => void;
  const promise = new Promise<V>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A Wilds room's loot, with a stubbed database (every call fails unless
 * a test says otherwise), herzies placed by hand, its own clock, and a
 * store for the crystal (`saved`, shared with another room if given). */
function wildsLoot(saved: { h?: HuntSaved } = {}) {
  const out: Outbound[] = [];
  const peers = new Map<string, WildsLootPeer>();
  const clock = { now: T };
  const db = {
    drop: vi.fn<WildsLootDb["drop"]>(async () => null),
    take: vi.fn<WildsLootDb["take"]>(async () => null),
    giveBack: vi.fn<WildsLootDb["giveBack"]>(async () => null),
    cache: vi.fn<WildsLootDb["cache"]>(async () => null),
  };
  let n = 0;
  const loot = new WildsLootRuntime({
    shard: SHARD,
    db,
    peer: (uid) => peers.get(uid) ?? null,
    here: () => peers.entries(),
    emit: (o) => out.push(o),
    clock: () => clock.now,
    newId: () => `drop-${++n}`,
    store: {
      load: () => saved.h,
      save: (h) => {
        saved.h = h;
      },
    },
  });
  const put = (
    uid: string,
    id: number,
    at: { x: number; z: number },
    down = false,
  ) => {
    peers.set(uid, { id, name: `Herzie ${uid}`, x: at.x, z: at.z, down });
    loot.claimFor(uid, CLAIM);
  };
  /** a (1) took b (2) down where it fell; the database dropped a Lute +3. */
  const dropped = async () => {
    put("a", 1, { x: 26, z: 0 });
    put("b", 2, FELL);
    db.drop.mockResolvedValueOnce({
      drop: { id: "drop-1", item: "lute", level: 3 },
    });
    await loot.takedown(
      { victim: "b", victimId: 2, killer: "a", at: FELL },
      T,
    );
    return said(out, "wildsDrop")[0]?.drop;
  };
  /** The room's ticks after `from` up to `to` (every 100 ms), each opening
   * the database answers awaited. When the database was first asked to
   * open the cache, if it was. */
  const ticks = async (from: number, to: number): Promise<number | null> => {
    let asked: number | null = null;
    for (let t = from + 100; t <= to; t += 100) {
      const calls = db.cache.mock.calls.length;
      await loot.step(t);
      if (asked === null && db.cache.mock.calls.length > calls) asked = t;
    }
    return asked;
  };
  /** Someone in the camp listens the crystal full, and stops: the first
   * cache turns up at AT. */
  const huntOut = () => {
    put("z", 9, { x: -73, z: 0.5 });
    loot.tune("z", true, T);
    loot.step(AT);
    loot.tune("z", false, AT);
  };
  return { loot, db, out, peers, clock, put, dropped, ticks, huntOut, saved };
}

describe("the Wilds' loot: a takedown's drop", () => {
  it("drops a card where the herzie fell, and tells the room and the victim", async () => {
    const w = wildsLoot();
    w.clock.now = T + 40; // the database's answer takes a moment
    const drop = await w.dropped();
    expect(w.db.drop).toHaveBeenCalledWith({
      id: "drop-1",
      event: EVENT,
      victim: "b",
      killer: "a",
      x: FELL.x,
      z: FELL.z,
    });
    expect(said(w.out, "wildsDrop")).toEqual([
      {
        t: "wildsDrop",
        from: 2,
        drop: {
          id: "drop-1",
          item: "lute",
          level: 3,
          x: FELL.x,
          z: FELL.z,
          firstFor: 1,
          firstUntil: T + 40 + WILDS_DROP.killerFirstMs,
          expiresAt: T + 40 + WILDS_DROP.lifeMs,
        },
      },
    ]);
    expect(said(w.out, "wildsLost", "b")).toEqual([
      { t: "wildsLost", item: "lute", level: 3 },
    ]);
    expect(drop?.id).toBe("drop-1");
    expect(w.loot.live).toBe(true);
  });

  it("drops nothing from an empty bag, and nothing without an event", async () => {
    const w = wildsLoot();
    w.put("a", 1, { x: 26, z: 0 });
    w.db.drop.mockResolvedValueOnce({ drop: null });
    await w.loot.takedown(
      { victim: "b", victimId: 2, killer: "a", at: FELL },
      T,
    );
    expect(w.out).toEqual([]);
    expect(w.loot.live).toBe(false);

    // No ticket claimed an event: no loot at all.
    const none = new WildsLootRuntime({
      shard: 0,
      db: w.db,
      peer: () => null,
      here: () => [],
      emit: (o) => w.out.push(o),
    });
    await none.takedown(
      { victim: "b", victimId: 2, killer: "a", at: FELL },
      T,
    );
    expect(w.db.drop).toHaveBeenCalledTimes(1);
    // Nor once the event's over.
    await w.loot.takedown(
      { victim: "b", victimId: 2, killer: "a", at: FELL },
      END,
    );
    expect(w.db.drop).toHaveBeenCalledTimes(1);
  });

  it("asks again on the sweep when the database didn't answer", async () => {
    const w = wildsLoot();
    w.put("a", 1, { x: 26, z: 0 });
    w.put("b", 2, FELL);
    await w.loot.takedown(
      { victim: "b", victimId: 2, killer: "a", at: FELL },
      T,
    );
    expect(w.out).toEqual([]);
    w.db.drop.mockResolvedValueOnce({
      drop: { id: "drop-1", item: "lute", level: 0 },
    });
    await w.loot.sweep(T + 30_000);
    expect(w.db.drop).toHaveBeenCalledTimes(2);
    expect(w.db.drop.mock.calls[1][0].id).toBe("drop-1");
    expect(said(w.out, "wildsDrop")).toHaveLength(1);
    // Answered: not asked again.
    await w.loot.sweep(T + 60_000);
    expect(w.db.drop).toHaveBeenCalledTimes(2);
  });

  it("gives the one who took the owner down 15 s alone with it", async () => {
    const w = wildsLoot();
    await w.dropped();
    w.put("c", 3, { x: 31, z: 0 });
    // Someone else in reach: not yet.
    await w.loot.take("c", "drop-1", T + 1_000);
    expect(said(w.out, "wildsRefused", "c")).toEqual([
      { t: "wildsRefused", id: "drop-1", why: "not-yet" },
    ]);
    expect(w.db.take).not.toHaveBeenCalled();

    // The killer walks over and takes it.
    w.put("a", 1, { x: 29, z: 0.5 });
    w.db.take.mockResolvedValueOnce({ ok: true, item: "lute", level: 3 });
    await w.loot.take("a", "drop-1", T + 2_000);
    expect(w.db.take).toHaveBeenCalledWith("drop-1", "a");
    expect(said(w.out, "wildsGone")).toEqual([
      { t: "wildsGone", id: "drop-1", by: 1 },
    ]);
    expect(said(w.out, "wildsTaken", "a")).toEqual([
      { t: "wildsTaken", item: "lute", level: 3 },
    ]);
    expect(w.loot.snapshot(T + 2_000).drops).toEqual([]);
  });

  it("lets anyone in reach take it once the killer's moment is over", async () => {
    const w = wildsLoot();
    await w.dropped();
    w.put("c", 3, { x: 31, z: 0 });
    // A full bag keeps it on the ground.
    w.db.take.mockResolvedValueOnce({ ok: false, why: "bag-full" });
    await w.loot.take("c", "drop-1", T + WILDS_DROP.killerFirstMs);
    expect(said(w.out, "wildsRefused", "c")).toEqual([
      { t: "wildsRefused", id: "drop-1", why: "bag-full" },
    ]);
    expect(w.loot.snapshot(T + 16_000).drops).toHaveLength(1);
    w.db.take.mockResolvedValueOnce({ ok: true, item: "lute", level: 3 });
    await w.loot.take("c", "drop-1", T + 16_000);
    expect(said(w.out, "wildsGone")).toEqual([
      { t: "wildsGone", id: "drop-1", by: 3 },
    ]);
  });

  it("refuses the far, the down, the gone, and a second hand while one's out", async () => {
    const w = wildsLoot();
    await w.dropped();
    const after = T + WILDS_DROP.killerFirstMs + 1;
    w.put("far", 3, { x: FELL.x + WILDS_DROP.reach + 1, z: 0 });
    w.put("down", 4, FELL, true);
    await w.loot.take("far", "drop-1", after);
    await w.loot.take("down", "drop-1", after);
    await w.loot.take("a", "nope", after);
    expect(said(w.out, "wildsRefused", "far")[0].why).toBe("far");
    expect(said(w.out, "wildsRefused", "down")[0].why).toBe("down");
    expect(said(w.out, "wildsRefused", "a")[0].why).toBe("gone");

    // Two at once: the second waits its turn.
    w.put("c", 5, FELL);
    w.put("d", 6, FELL);
    const slow = deferred<WildsTakeReply | null>();
    w.db.take.mockReturnValueOnce(slow.promise);
    const first = w.loot.take("c", "drop-1", after);
    await w.loot.take("d", "drop-1", after);
    expect(said(w.out, "wildsRefused", "d")).toEqual([
      { t: "wildsRefused", id: "drop-1", why: "not-yet" },
    ]);
    // The database had already given it back: gone for everyone.
    slow.resolve({ ok: false, why: "gone" });
    await first;
    expect(said(w.out, "wildsGone")).toEqual([
      { t: "wildsGone", id: "drop-1", by: null },
    ]);
    expect(said(w.out, "wildsRefused", "c")[0].why).toBe("gone");

    // A take the database didn't answer is just refused, and it stays.
    const w2 = wildsLoot();
    await w2.dropped();
    w2.put("a", 1, FELL);
    await w2.loot.take("a", "drop-1", T + 100);
    expect(said(w2.out, "wildsRefused", "a")[0].why).toBe("not-yet");
    expect(w2.loot.snapshot(T + 100).drops).toHaveLength(1);
  });

  it("gives an unclaimed drop back to its owner after 2 min", async () => {
    const w = wildsLoot();
    await w.dropped();
    // Not yet.
    await w.loot.sweep(T + WILDS_DROP.lifeMs - 1);
    expect(w.db.giveBack).not.toHaveBeenCalled();
    // Past its life: given back (a failed ask keeps it for the next sweep).
    await w.loot.sweep(T + WILDS_DROP.lifeMs);
    expect(w.db.giveBack).toHaveBeenCalledWith(["drop-1"]);
    expect(said(w.out, "wildsGone")).toEqual([]);
    // Too late to take now.
    await w.loot.take("a", "drop-1", T + WILDS_DROP.lifeMs + 1);
    expect(said(w.out, "wildsRefused", "a")[0].why).toBe("gone");
    w.db.giveBack.mockResolvedValueOnce({ returned: ["drop-1"] });
    await w.loot.sweep(T + WILDS_DROP.lifeMs + 30_000);
    expect(said(w.out, "wildsGone")).toEqual([
      { t: "wildsGone", id: "drop-1", by: null, back: true },
    ]);
    expect(w.loot.live).toBe(false);
  });

  it("only says `back` for those that went back", async () => {
    const w = wildsLoot();
    await w.dropped();
    w.db.giveBack.mockResolvedValueOnce({ returned: [] });
    await w.loot.sweep(T + WILDS_DROP.lifeMs);
    expect(said(w.out, "wildsGone")).toEqual([
      { t: "wildsGone", id: "drop-1", by: null },
    ]);
  });
});

describe("the Wilds' loot: the Hunt Crystal", () => {
  const FULL = T + WILDS_HUNT_FILL_MS;

  it("fills with one herzie listening, and brings out a cache when full", () => {
    const w = wildsLoot();
    w.put("a", 1, { x: 0, z: 0 });
    w.loot.step(T);
    // Dull, and nobody's listening.
    expect(said(w.out, "wildsHunt")).toEqual([
      {
        t: "wildsHunt",
        hunt: { charge: 0, rate: 0, at: T, listeners: 0 },
      },
    ]);
    expect(w.loot.live).toBe(false);
    w.loot.tune("a", true, T);
    expect(said(w.out, "wildsHunt").at(-1)?.hunt).toEqual({
      charge: 0,
      rate: huntRate(1),
      at: T,
      listeners: 1,
    });
    // Filling keeps the room awake, and isn't told as it fills.
    expect(w.loot.live).toBe(true);
    w.loot.step(FULL - 1);
    expect(said(w.out, "wildsHunt")).toHaveLength(2);
    expect(said(w.out, "wildsCache")).toEqual([]);
    // Five minutes alone: full, and a cache turns up.
    w.loot.step(FULL);
    const spot = wildsCacheSpot(EVENT, 0);
    expect(said(w.out, "wildsCache")).toEqual([
      {
        t: "wildsCache",
        cache: { id: wildsCacheId(EVENT, FULL, SHARD), ...spot },
      },
    ]);
    // It stays full while the hunt's on, however much more is played.
    expect(said(w.out, "wildsHunt").at(-1)?.hunt).toEqual({
      charge: 1,
      rate: 0,
      at: FULL,
      listeners: 1,
    });
    w.loot.step(FULL + 60_000);
    expect(said(w.out, "wildsCache")).toHaveLength(1);
    expect(w.loot.snapshot(FULL + 60_000).hunt?.charge).toBe(1);
    expect(w.loot.live).toBe(false);
  });

  it("fills quicker the more listen, and keeps its charge when nobody does", () => {
    const w = wildsLoot();
    w.put("a", 1, { x: 0, z: 0 });
    w.put("b", 2, { x: 5, z: 0 });
    w.loot.tune("a", true, T);
    w.loot.tune("b", true, T);
    expect(said(w.out, "wildsHunt").at(-1)?.hunt?.rate).toBe(huntRate(2));
    expect(huntRate(2)).toBeGreaterThan(huntRate(1));
    // b stops a minute in; a leaves a minute after.
    w.loot.tune("b", false, T + 60_000);
    const once = huntRate(2) * 60_000;
    expect(said(w.out, "wildsHunt").at(-1)?.hunt?.charge).toBeCloseTo(once, 4);
    w.loot.leave("a");
    w.peers.delete("a");
    w.loot.step(T + 120_000);
    const twice = once + huntRate(1) * 60_000;
    expect(said(w.out, "wildsHunt").at(-1)?.hunt).toMatchObject({
      rate: 0,
      listeners: 0,
    });
    expect(w.loot.snapshot(T + 120_000).hunt?.charge).toBeCloseTo(twice, 4);
    // Kept, with nobody listening (and nothing to stay awake for).
    expect(w.loot.snapshot(T + 600_000).hunt?.charge).toBeCloseTo(twice, 4);
    expect(w.loot.live).toBe(false);
  });

  it("counts only herzies here with music on and a ticket for the event", () => {
    const w = wildsLoot();
    w.put("a", 1, { x: 0, z: 0 });
    w.peers.set("old", { id: 3, name: "Old", x: 0, z: 0, down: false });
    w.loot.claimFor("old", { event: "old", startsAt: 0, endsAt: END });
    w.loot.tune("old", true, T);
    // Said it's playing, but isn't here any more.
    w.loot.tune("gone", true, T);
    expect(said(w.out, "wildsHunt").at(-1)?.hunt?.listeners).toBe(0);
    w.loot.tune("a", true, T);
    expect(said(w.out, "wildsHunt").at(-1)?.hunt?.listeners).toBe(1);
  });

  it("goes dull once its cache is opened, and the next turns up elsewhere", async () => {
    const w = wildsLoot();
    w.put("a", 1, { x: 0, z: 0 });
    w.loot.tune("a", true, T);
    w.loot.step(FULL);
    const first = wildsCacheSpot(EVENT, 0);
    // a walks over and holds it out.
    w.put("a", 1, first);
    w.db.cache.mockResolvedValueOnce({ opened: true, drops: [] });
    const asked = await w.ticks(FULL, FULL + 2 * WILDS_CACHE_HOLD_MS);
    expect(asked).toBe(FULL + 100 + WILDS_CACHE_HOLD_MS);
    expect(said(w.out, "wildsHunt").at(-1)?.hunt).toEqual({
      charge: 0,
      rate: huntRate(1),
      at: asked,
      listeners: 1,
    });
    // Still listening: full again five minutes on, somewhere else.
    const again = (asked ?? 0) + WILDS_HUNT_FILL_MS + 1_000;
    w.loot.step(again);
    const next = said(w.out, "wildsCache").at(-1)?.cache;
    expect(next).toEqual({
      id: wildsCacheId(EVENT, again, SHARD),
      ...wildsCacheSpot(EVENT, 1),
    });
    expect(wildsCacheSpot(EVENT, 1)).not.toEqual(first);
  });

  it("is gone with the event, and its cache with it", () => {
    const w = wildsLoot();
    w.huntOut();
    w.loot.step(END);
    expect(said(w.out, "wildsCache").at(-1)).toEqual({
      t: "wildsCache",
      cache: null,
    });
    expect(said(w.out, "wildsHunt").at(-1)).toEqual({
      t: "wildsHunt",
      hunt: null,
    });
    expect(w.loot.snapshot(END).hunt).toBeNull();
  });

  it("keeps its charge and its cache over a sleep, for the same event", () => {
    const store: { h?: HuntSaved } = {};
    const w = wildsLoot(store);
    w.huntOut();
    const cache = w.loot.snapshot(AT).cache;
    expect(cache).not.toBeNull();
    // The room wakes: a fresh runtime, the same storage.
    const woke = wildsLoot(store);
    woke.put("a", 1, { x: 0, z: 0 });
    woke.loot.step(AT + 60_000);
    expect(woke.loot.snapshot(AT + 60_000)).toMatchObject({
      cache,
      hunt: { charge: 1, rate: 0 },
    });
    // A new event's crystal starts dull.
    const later = wildsLoot(store);
    later.loot.claimFor("a", { event: "next", startsAt: T, endsAt: END });
    later.peers.set("a", { id: 1, name: "a", x: 0, z: 0, down: false });
    later.loot.step(T + 1);
    expect(later.loot.snapshot(T + 1)).toMatchObject({
      cache: null,
      hunt: { charge: 0 },
    });
  });
});

describe("the Wilds' loot: caches", () => {
  const id = wildsCacheId(EVENT, AT, SHARD);
  const spot = wildsCacheSpot(EVENT, 0);
  const at = { x: spot?.x ?? 0, z: spot?.z ?? 0 };
  /** In the ring, a step from its edge (not on the chest). */
  const near = { x: at.x + WILDS_CACHE_HOLD_RADIUS - 1, z: at.z };
  const across = { x: at.x - WILDS_CACHE_HOLD_RADIUS + 1, z: at.z };
  const out = { x: at.x + WILDS_CACHE_HOLD_RADIUS + 1, z: at.z };
  const drops: LootDrop[] = [
    { id: "p1", item: "tonewood" },
    { id: "p2", item: "sky-string" },
  ];

  it("opens for a herzie who holds it alone for 10 s, once", async () => {
    const w = wildsLoot();
    w.huntOut();
    w.put("a", 1, near);
    w.loot.step(AT);
    expect(said(w.out, "wildsHold")).toEqual([
      {
        t: "wildsHold",
        id,
        holders: [{ id: 1, ms: 0 }],
        contested: false,
        at: AT,
      },
    ]);
    // Holding keeps the room awake, and isn't told as it counts.
    expect(w.loot.live).toBe(true);
    w.db.cache.mockResolvedValueOnce({ opened: true, drops });
    expect(await w.ticks(AT, AT + WILDS_CACHE_HOLD_MS)).toBe(
      AT + WILDS_CACHE_HOLD_MS,
    );
    expect(said(w.out, "wildsHold")).toHaveLength(1);
    expect(w.db.cache).toHaveBeenCalledWith({
      id,
      event: EVENT,
      uid: "a",
      x: at.x,
      z: at.z,
    });
    expect(said(w.out, "wildsCache").at(-1)).toEqual({
      t: "wildsCache",
      cache: null,
      by: 1,
      byName: "Herzie a",
    });
    expect(said(w.out, "loot", "a")).toEqual([{ t: "loot", drops, at }]);
    // Still standing there: nothing more, and the cache doesn't come back.
    const told = said(w.out, "wildsCache").length;
    await w.ticks(AT + WILDS_CACHE_HOLD_MS, AT + 3 * WILDS_CACHE_HOLD_MS);
    expect(w.db.cache).toHaveBeenCalledTimes(1);
    expect(said(w.out, "loot", "a")).toHaveLength(1);
    expect(said(w.out, "wildsCache")).toHaveLength(told);
    expect(w.loot.snapshot(AT + 3 * WILDS_CACHE_HOLD_MS).cache).toBeNull();
    expect(w.loot.live).toBe(false);
  });

  it("starts a herzie over who steps out of the ring", async () => {
    const w = wildsLoot();
    w.huntOut();
    w.put("a", 1, near);
    w.loot.step(AT);
    await w.ticks(AT, AT + 6_000);
    w.put("a", 1, out);
    w.loot.step(AT + 6_100);
    expect(said(w.out, "wildsHold").at(-1)).toEqual({
      t: "wildsHold",
      id,
      holders: [],
      contested: false,
      at: AT + 6_100,
    });
    // Back in: from nothing (told once a moment has passed since the last).
    w.put("a", 1, near);
    w.loot.step(AT + 6_200);
    expect(said(w.out, "wildsHold")).toHaveLength(2);
    w.loot.step(AT + 6_300);
    w.loot.step(AT + 6_400);
    expect(said(w.out, "wildsHold").at(-1)).toEqual({
      t: "wildsHold",
      id,
      holders: [{ id: 1, ms: 200 }],
      contested: false,
      at: AT + 6_400,
    });
    expect(await w.ticks(AT + 6_400, AT + 30_000)).toBe(
      AT + 6_200 + WILDS_CACHE_HOLD_MS,
    );
  });

  it("pauses everyone's hold while it's contested, and goes on after", async () => {
    const w = wildsLoot();
    w.huntOut();
    w.put("a", 1, near);
    w.loot.step(AT);
    await w.ticks(AT, AT + 4_000);
    // b steps in: contested, a's 4 s kept but going nowhere.
    w.put("b", 2, across);
    w.loot.step(AT + 4_100);
    expect(said(w.out, "wildsHold").at(-1)).toEqual({
      t: "wildsHold",
      id,
      holders: [
        { id: 1, ms: 4_000 },
        { id: 2, ms: 0 },
      ],
      contested: true,
      at: AT + 4_100,
    });
    expect(await w.ticks(AT + 4_100, AT + 30_000)).toBeNull();
    expect(w.loot.snapshot(AT + 30_000).hold).toEqual({
      holders: [
        { id: 1, ms: 4_000 },
        { id: 2, ms: 0 },
      ],
      contested: true,
      at: AT + 30_000,
    });
    // A herzie down in the ring doesn't contest it.
    w.put("b", 2, across, true);
    w.loot.step(AT + 30_100);
    expect(said(w.out, "wildsHold").at(-1)).toMatchObject({
      holders: [{ id: 1, ms: 4_100 }],
      contested: false,
    });
    // a goes on from where it was.
    expect(await w.ticks(AT + 30_100, AT + 60_000)).toBe(
      AT + 30_100 + WILDS_CACHE_HOLD_MS - 4_100,
    );
    expect(w.db.cache.mock.calls[0][0].uid).toBe("a");
  });

  it("starts a herzie over who goes down", async () => {
    const w = wildsLoot();
    w.huntOut();
    w.put("a", 1, near);
    w.loot.step(AT);
    await w.ticks(AT, AT + 8_000);
    w.put("a", 1, near, true);
    w.loot.step(AT + 8_100);
    expect(said(w.out, "wildsHold").at(-1)?.holders).toEqual([]);
    // Up again where it fell: from nothing.
    w.put("a", 1, near);
    expect(await w.ticks(AT + 8_100, AT + 30_000)).toBe(
      AT + 8_200 + WILDS_CACHE_HOLD_MS,
    );
  });

  it("keeps the cache out when the database doesn't answer, and asks again", async () => {
    const w = wildsLoot();
    w.huntOut();
    w.put("a", 1, near);
    w.loot.step(AT);
    const first = AT + WILDS_CACHE_HOLD_MS;
    expect(await w.ticks(AT, first)).toBe(first);
    expect(said(w.out, "wildsRefused", "a")).toEqual([
      { t: "wildsRefused", id, why: "not-yet" },
    ]);
    expect(w.loot.snapshot(first).cache?.id).toBe(id);
    // Held a little longer, asked again.
    w.db.cache.mockResolvedValueOnce({ opened: true, drops });
    expect(await w.ticks(first, first + 10_000)).toBe(first + HOLD_RETRY_MS);
    expect(w.db.cache).toHaveBeenCalledTimes(2);
    expect(said(w.out, "loot", "a")).toHaveLength(1);
  });

  it("takes the database's word when someone got there first", async () => {
    const w = wildsLoot();
    w.huntOut();
    w.put("a", 1, near);
    w.loot.step(AT);
    w.db.cache.mockResolvedValueOnce({ opened: false, drops: [] });
    await w.ticks(AT, AT + WILDS_CACHE_HOLD_MS);
    expect(said(w.out, "wildsCache").at(-1)).toEqual({
      t: "wildsCache",
      cache: null,
    });
    expect(said(w.out, "wildsRefused", "a")[0].why).toBe("gone");
    expect(said(w.out, "loot", "a")).toEqual([]);
  });

  it("holds nothing for a herzie out of the ring", async () => {
    const w = wildsLoot();
    w.huntOut();
    w.put("a", 1, out);
    w.loot.step(AT);
    expect(await w.ticks(AT, AT + 30_000)).toBeNull();
    expect(said(w.out, "wildsHold")).toEqual([]);
    expect(w.loot.live).toBe(false);
  });
});

describe("the Wilds' loot: who's here", () => {
  it("reports the herzies here holding the event's claim, while it's on", () => {
    const w = wildsLoot();
    w.put("a", 1, { x: 0, z: 0 });
    w.put("b", 2, { x: 0, z: 0 });
    // An older event's ticket, and one with none.
    w.loot.claimFor("c", { event: "old", startsAt: 0, endsAt: START });
    w.loot.claimFor("d", undefined);
    expect(w.loot.event).toEqual(CLAIM);
    expect(w.loot.presence(START - 1)).toBeNull();
    expect(w.loot.presence(T)).toEqual({ event: EVENT, uids: ["a", "b"] });
    w.loot.leave("a");
    expect(w.loot.presence(T)).toEqual({ event: EVENT, uids: ["b"] });
    // b's renewed ticket has no claim any more.
    w.loot.claimFor("b", undefined);
    expect(w.loot.presence(T)).toBeNull();
    w.put("e", 5, { x: 0, z: 0 });
    expect(w.loot.presence(END)).toBeNull();
  });

  it("follows the newest event a ticket claims", () => {
    const w = wildsLoot();
    w.put("a", 1, { x: 0, z: 0 });
    const next = { event: "next", startsAt: END, endsAt: END + 60_000 };
    w.loot.claimFor("b", next);
    expect(w.loot.event).toEqual(next);
    // An old ticket doesn't take it back; the same event's window moves.
    w.loot.claimFor("c", CLAIM);
    expect(w.loot.event).toEqual(next);
    const longer = { ...next, endsAt: END + 120_000 };
    w.loot.claimFor("b", longer);
    expect(w.loot.event).toEqual(longer);
  });
});

describe("the Wilds' loot: a newcomer's snapshot", () => {
  it("holds what lies about, the cache that's out and the crystal", async () => {
    const w = wildsLoot();
    w.huntOut();
    w.clock.now = AT;
    await w.dropped();
    const snap = w.loot.snapshot(AT);
    expect(snap).toEqual({
      t: "wildsLoot",
      drops: [said(w.out, "wildsDrop")[0].drop],
      cache: { id: wildsCacheId(EVENT, AT, SHARD), ...wildsCacheSpot(EVENT, 0) },
      hold: null,
      hunt: { charge: 1, rate: 0, at: AT, listeners: 0 },
    });
    // A drop past its life isn't shown, even before the sweep returns it.
    expect(w.loot.snapshot(AT + WILDS_DROP.lifeMs).drops).toEqual([]);
  });
});
