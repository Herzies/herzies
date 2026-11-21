import type { ServerMessage } from "@herzies/shared/town-net";
import {
  WILDS_CACHE_HOLD_MS,
  WILDS_DROP,
  type WildsGroundDrop,
} from "@herzies/shared/wilds-loot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  asked,
  cardInReach,
  compassFrom,
  handleWildsLootMessage,
  heldBy,
  heldByOthers,
  mayAsk,
  resetWildsLoot,
  type WildsLootContext,
  wildsLoot,
} from "./loot";

const noticed = vi.hoisted(() => [] as string[]);
vi.mock("../../../lib/notices", () => ({
  notify: (text: string) => {
    noticed.push(text);
  },
}));

/** The server's clock runs this far behind this machine's. */
const OFFSET = 5_000;
let now = 0;
let map = "wilds";
const me = { x: 0, z: 0 };

const ctx: WildsLootContext = {
  toLocal: (t) => t + OFFSET,
  you: () => wildsLoot.you,
  map: () => map,
  me: () => me,
};
const recv = (m: ServerMessage) => handleWildsLootMessage(m, ctx);
const welcome = (you = 1) => recv({ t: "welcome", you, players: [] });

function drop(over: Partial<WildsGroundDrop> = {}): WildsGroundDrop {
  return {
    id: "d1",
    item: "tonewood",
    level: 0,
    x: 1,
    z: 0,
    firstFor: null,
    firstUntil: 0,
    expiresAt: 120_000,
    ...over,
  };
}

beforeEach(() => {
  now = 0;
  map = "wilds";
  me.x = 0;
  me.z = 0;
  noticed.length = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  resetWildsLoot();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Wilds' loot on the client", () => {
  it("offers the nearest card in reach, only when it may be taken", () => {
    welcome(1);
    // Someone else's first for a while (server 10 000 → here 15 000).
    recv({
      t: "wildsDrop",
      drop: drop({ firstFor: 2, firstUntil: 10_000 }),
      from: 3,
    });
    expect(cardInReach(me, now, false)).toBeNull();
    now = 15_000;
    expect(cardInReach(me, now, false)?.id).toBe("d1");
    // A nearer one wins.
    recv({ t: "wildsDrop", drop: drop({ id: "d2", x: 0.5 }), from: 3 });
    expect(cardInReach(me, now, false)?.id).toBe("d2");
    // Out of reach, or down: nothing.
    me.x = -WILDS_DROP.reach;
    expect(cardInReach(me, now, false)).toBeNull();
    me.x = 0;
    expect(cardInReach(me, now, true)).toBeNull();
  });

  it("lets the one who took the owner down have it first", () => {
    welcome(2);
    recv({
      t: "wildsDrop",
      drop: drop({ firstFor: 2, firstUntil: 10_000 }),
      from: 3,
    });
    expect(cardInReach(me, now, false)?.id).toBe("d1");
  });

  it("asks for a card again at once after a refusal, saying why", () => {
    welcome(1);
    recv({ t: "wildsDrop", drop: drop(), from: 3 });
    asked("d1", now);
    expect(mayAsk("d1", now + 100)).toBe(false);
    recv({ t: "wildsRefused", id: "d1", why: "bag-full" });
    expect(noticed.at(-1)).toBe('Your bag is full: no room for "Tonewood"');
    expect(mayAsk("d1", now + 100)).toBe(true);
    recv({ t: "wildsRefused", id: "d1", why: "not-yet" });
    expect(noticed.at(-1)).toBe('Couldn\'t pick up "Tonewood" just now');
    // Gone: off the ground.
    recv({ t: "wildsRefused", id: "d1", why: "gone" });
    expect(wildsLoot.drops.size).toBe(0);
  });

  it("counts a hold on from the room's word, and says who opened it", () => {
    welcome(1);
    me.x = 0;
    me.z = 40;
    recv({ t: "wildsCache", cache: { id: "c1", x: 30, z: 10 } });
    expect(noticed.at(-1)).toBe("A cache turned up to the north-east");
    // Someone else steps up (server 1 000 → here 6 000): said, counted on.
    recv({
      t: "wildsHold",
      id: "c1",
      holders: [{ id: 2, ms: 500 }],
      contested: false,
      at: 1_000,
    });
    expect(noticed.at(-1)).toBe(
      "Someone's opening the cache to the north-east",
    );
    now = 7_000;
    expect(heldBy(1, now)).toBeNull();
    expect(heldByOthers(1, now)).toBe(1_500);
    // You step in too: contested, and everyone's stands still.
    recv({
      t: "wildsHold",
      id: "c1",
      holders: [
        { id: 2, ms: 1_500 },
        { id: 1, ms: 0 },
      ],
      contested: true,
      at: 2_000,
    });
    now = 20_000;
    expect(heldBy(1, now)).toBe(0);
    expect(heldByOthers(1, now)).toBe(1_500);
    // They go: yours counts on, up to the full hold.
    recv({
      t: "wildsHold",
      id: "c1",
      holders: [{ id: 1, ms: 0 }],
      contested: false,
      at: 15_000,
    });
    now = 24_000;
    expect(heldBy(1, now)).toBe(4_000);
    expect(heldByOthers(1, now)).toBeNull();
    expect(heldBy(1, 60_000)).toBe(WILDS_CACHE_HOLD_MS);
    // Word of another cache isn't word of this one.
    recv({
      t: "wildsHold",
      id: "c0",
      holders: [],
      contested: false,
      at: 0,
    });
    expect(heldBy(1, now)).toBe(4_000);
    // Held out, but the room couldn't open it just now: said; it stays.
    recv({ t: "wildsRefused", id: "c1", why: "not-yet" });
    expect(noticed.at(-1)).toBe(
      "The cache didn't open just yet: hold on a moment more",
    );
    expect(wildsLoot.cache?.id).toBe("c1");
    recv({ t: "wildsCache", cache: null, by: 1, byName: "Me" });
    expect(noticed.at(-1)).toBe("You opened the cache");
    expect(wildsLoot.cache).toBeNull();
    expect(wildsLoot.hold).toBeNull();
  });

  it("says once a while that someone's opening it", () => {
    welcome(1);
    recv({ t: "wildsCache", cache: { id: "c1", x: 0, z: -30 } });
    const hold = (holders: { id: number; ms: number }[]) =>
      recv({ t: "wildsHold", id: "c1", holders, contested: false, at: 0 });
    hold([{ id: 2, ms: 0 }]);
    hold([]);
    hold([{ id: 2, ms: 0 }]);
    expect(noticed.filter((n) => n.startsWith("Someone's"))).toHaveLength(1);
    // Nor while you're holding it yourself.
    now = 30_000;
    hold([{ id: 1, ms: 0 }]);
    hold([
      { id: 1, ms: 0 },
      { id: 2, ms: 0 },
    ]);
    expect(noticed.filter((n) => n.startsWith("Someone's"))).toHaveLength(1);
    recv({ t: "wildsCache", cache: null, by: 4, byName: "Bo" });
    expect(noticed.at(-1)).toBe('"Bo" opened the cache');
  });

  it("forgets it all off the Wilds", () => {
    welcome(1);
    recv({
      t: "wildsLoot",
      drops: [drop()],
      cache: { id: "c1", x: 0, z: -30 },
      hold: { holders: [{ id: 2, ms: 3_000 }], contested: false, at: 0 },
    });
    expect(noticed.at(-1)).toBe("There's a cache out to the north");
    // Said at server 0 (here 5 000): not counted on before it was said.
    expect(heldByOthers(1, now)).toBe(3_000);
    map = "home";
    welcome(1);
    expect(wildsLoot.you).toBeNull();
    expect(wildsLoot.drops.size).toBe(0);
    expect(wildsLoot.cache).toBeNull();
    expect(wildsLoot.hold).toBeNull();
  });

  it("leaves the welcome and everything else to the others", () => {
    expect(welcome()).toBe(false);
    expect(recv({ t: "loot", drops: [], at: { x: 0, z: 0 } })).toBe(false);
  });

  it("reads a direction off the compass", () => {
    expect(compassFrom({ x: 0, z: 0 }, { x: 0, z: -20 })).toBe("to the north");
    expect(compassFrom({ x: 0, z: 0 }, { x: 20, z: 0 })).toBe("to the east");
    expect(compassFrom({ x: 0, z: 0 }, { x: -20, z: 20 })).toBe(
      "to the south-west",
    );
    expect(compassFrom({ x: 0, z: 0 }, { x: 2, z: 2 })).toBe("close by");
  });
});
