import type { ServerMessage } from "@herzies/shared/town-net";
import { WILDS_SAFE_CAMP } from "@herzies/shared/wilds";
import { WILDS_PVP } from "@herzies/shared/wilds-pvp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  feedLine,
  handleWildsMessage,
  inCombatUntil,
  myWildsDown,
  myWildsHp,
  onWildsEvent,
  resetWilds,
  type WildsContext,
  type WildsEvent,
  wildsBarOf,
  wildsFoe,
  wildsHeld,
  wildsOn,
} from "./store";

/** The server's clock runs this far behind this machine's. */
const OFFSET = 5_000;
let now = 0;
let map = "wilds";
let events: WildsEvent[] = [];
let off: () => void = () => {};

const ctx: WildsContext = { toLocal: (t) => t + OFFSET, map: () => map };
const recv = (m: ServerMessage) => handleWildsMessage(m, ctx);
const welcome = (you = 1) => recv({ t: "welcome", you, players: [] });

/** Out in the free-for-all; in the camp. */
const OUT = { x: 30, z: 0 };
const OUT2 = { x: 34, z: 0 };
const CAMP = { x: WILDS_SAFE_CAMP.x, z: WILDS_SAFE_CAMP.z };

beforeEach(() => {
  now = 0;
  map = "wilds";
  events = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  off = onWildsEvent((e) => events.push(e));
  resetWilds();
});

afterEach(() => {
  off();
  vi.restoreAllMocks();
});

describe("the Wilds on the client", () => {
  it("is on only in a Wilds room", () => {
    welcome();
    expect(wildsOn()).toBe(true);
    map = "home";
    welcome();
    expect(wildsOn()).toBe(false);
    // Anything said of PvP outside the Wilds is dropped.
    expect(recv({ t: "pvp", id: 2, hp: 1, maxHp: 10 })).toBe(true);
    expect(wildsBarOf(2)).toBeUndefined();
  });

  it("aims only at herzies it may hurt, out of the camp", () => {
    welcome();
    expect(wildsFoe(2, OUT2, OUT)).toBe(true);
    expect(wildsFoe(2, CAMP, OUT)).toBe(false);
    expect(wildsFoe(2, OUT2, CAMP)).toBe(false);
    expect(wildsFoe(1, OUT, OUT)).toBe(false);
    // Protected (server ms 1 000 → here 6 000), then not.
    recv({ t: "pvp", id: 2, hp: 100, maxHp: 100, shield: 1_000 });
    expect(wildsFoe(2, OUT2, OUT)).toBe(false);
    now = 6_001;
    expect(wildsFoe(2, OUT2, OUT)).toBe(true);
    // Down: not a target; nor is anyone while you're down.
    recv({ t: "pvp", id: 2, hp: 0, maxHp: 100, down: 9_000 });
    expect(wildsFoe(2, OUT2, OUT)).toBe(false);
    recv({ t: "pvp", id: 3, hp: 100, maxHp: 100 });
    recv({ t: "pvp", id: 1, hp: 0, maxHp: 100, down: 9_000 });
    expect(wildsFoe(3, OUT2, OUT)).toBe(false);
  });

  it("shows a herzie's bar once it's hurt, and while in a fight", () => {
    welcome();
    recv({ t: "pvp", id: 2, hp: 100, maxHp: 100, shield: 1_000 });
    expect(wildsBarOf(2)).toBeUndefined();
    now = 7_000;
    recv({ t: "pvp", id: 2, hp: 80, maxHp: 100, by: 1 });
    expect(wildsBarOf(2)).toMatchObject({ hp: 80, maxHp: 100 });
    expect(events).toContainEqual({
      k: "hp",
      id: 2,
      hp: 80,
      was: 100,
      maxHp: 100,
      by: 1,
    });
    // Healed to full: shown a while longer (it was just in a fight).
    now = 8_000;
    recv({ t: "pvp", id: 2, hp: 100, maxHp: 100 });
    expect(wildsBarOf(2)).toBeDefined();
    now = 7_000 + WILDS_PVP.combatMs;
    expect(wildsBarOf(2)).toBeUndefined();
  });

  it("goes down, holds you, counts down and stands you up", () => {
    welcome();
    recv({ t: "pvp", id: 1, hp: 100, maxHp: 100 });
    expect(myWildsHp()).toEqual({ hp: 100, maxHp: 100 });
    now = 1_000;
    recv({ t: "pvp", id: 1, hp: 0, maxHp: 100, down: 2_000, by: 2 });
    expect(myWildsDown()).toBe(true);
    expect(wildsHeld()).toBe(true);
    expect(events.map((e) => e.k)).toEqual(["hp", "down"]);
    // In combat (no boarding a ship home) for the window after the hit.
    expect(inCombatUntil()).toBe(1_000 + WILDS_PVP.combatMs);
    // Up in the camp: no heal number, and the fight's over.
    events = [];
    now = 7_000;
    recv({ t: "pvp", id: 1, hp: 100, maxHp: 100, shield: 7_000 });
    expect(myWildsDown()).toBe(false);
    expect(wildsHeld()).toBe(false);
    expect(events).toEqual([{ k: "up", id: 1 }]);
    expect(inCombatUntil()).toBe(Number.NEGATIVE_INFINITY);
  });

  it("holds you while stunned", () => {
    welcome();
    recv({ t: "pvp", id: 1, hp: 90, maxHp: 100 });
    recv({ t: "pvpStun", id: 1, until: 500 });
    now = 5_400;
    expect(wildsHeld()).toBe(true);
    now = 5_500;
    expect(wildsHeld()).toBe(false);
  });

  it("is never in combat outside the Wilds", () => {
    map = "home";
    welcome();
    expect(inCombatUntil()).toBe(Number.NEGATIVE_INFINITY);
  });

  it("forgets herzies that leave", () => {
    welcome();
    recv({ t: "pvp", id: 2, hp: 50, maxHp: 100 });
    expect(wildsBarOf(2)).toBeDefined();
    expect(recv({ t: "leave", id: 2 })).toBe(false);
    expect(wildsBarOf(2)).toBeUndefined();
  });

  it("words the kill feed for whoever reads it", () => {
    const m = {
      t: "pvpFeed" as const,
      by: 1,
      byName: "Ada",
      victim: 2,
      victimName: "Bo",
    };
    expect(feedLine(m, 1)).toBe('Took down "Bo"');
    expect(feedLine(m, 2)).toBe('"Ada" took you down');
    expect(feedLine(m, 3)).toBe('"Ada" took down "Bo"');
    expect(feedLine({ ...m, logged: true }, 1)).toBe(
      'Took down "Bo" (they left mid-fight)',
    );
    welcome();
    recv({ ...m, by: 1 });
    expect(events).toContainEqual({
      k: "feed",
      text: 'Took down "Bo"',
      won: true,
    });
  });
});
