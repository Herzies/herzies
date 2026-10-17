import { getItem, RARITY_COLORS } from "@herzies/shared";
import { BOSS_STAND } from "@herzies/shared/combat";
import { describe, expect, it } from "vitest";
import {
  flightAt,
  LOOT,
  landingSpots,
  restAt,
  SETTLE_MS,
  tierOf,
  voxelsOf,
} from "./loot";

describe("the voxel model", () => {
  it("keeps a card's shape: a glowing rarity frame and the picture proud", () => {
    const cd = getItem("cd");
    if (!cd) throw new Error("no cd");
    const v = voxelsOf(cd);
    const frame = v.filter((x) => x.glow);
    expect(frame.length).toBeGreaterThan(0);
    expect(new Set(frame.map((x) => x.color))).toEqual(
      new Set([RARITY_COLORS[cd.rarity]]),
    );
    // The disc stands out of the face; the face itself doesn't.
    const proud = v.filter((x) => x.z === 2 && !x.glow);
    expect(proud.length).toBeGreaterThan(10);
    expect(proud.length).toBeLessThan(14 * 20);
  });

  it("extrudes anything that isn't a card", () => {
    const pick = getItem("safety-pick");
    if (!pick) throw new Error("no safety pick");
    const v = voxelsOf(pick);
    expect(v.some((x) => x.glow)).toBe(false);
    expect(Math.max(...v.map((x) => x.z))).toBe(1);
  });
});

describe("where it lands", () => {
  it("in front of the boss, toward you, and apart", () => {
    const player = { x: 0, z: 8 };
    const spots = landingSpots(3, player, () => 0.5);
    for (const s of spots) {
      const r = Math.hypot(s.x - BOSS_STAND.x, s.z - BOSS_STAND.z);
      expect(r).toBeGreaterThan(LOOT.landNear - 0.5);
      expect(r).toBeLessThan(LOOT.landFar + 1);
      expect(s.z).toBeGreaterThan(BOSS_STAND.z);
    }
    for (let i = 0; i < spots.length; i++)
      for (let j = i + 1; j < spots.length; j++)
        expect(
          Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z),
        ).toBeGreaterThanOrEqual(LOOT.spacing - 1e-6);
  });
});

describe("where a boss's full haul lands", () => {
  it("a dozen stay apart, in front of the boss, inside the cave", () => {
    const spots = landingSpots(12, { x: 0, z: 8 }, () => 0.5);
    for (const s of spots) {
      expect(s.z).toBeGreaterThan(BOSS_STAND.z - 1);
      expect(Math.abs(s.x)).toBeLessThan(12);
    }
    for (let i = 0; i < spots.length; i++)
      for (let j = i + 1; j < spots.length; j++)
        expect(
          Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z),
        ).toBeGreaterThanOrEqual(LOOT.spacing * 0.9);
  });
});

describe("its path", () => {
  it("leaves the chest, peaks above it, and lands on the floor", () => {
    const to = { x: 2, z: 0 };
    expect(flightAt(to, 0).y).toBeCloseTo(BOSS_STAND.chest);
    const peak = Math.max(
      ...Array.from(
        { length: 50 },
        (_, i) => flightAt(to, (i / 49) * LOOT.flightMs).y,
      ),
    );
    expect(peak).toBeCloseTo(BOSS_STAND.chest + LOOT.apex, 1);
    const end = flightAt(to, LOOT.flightMs);
    expect(end).toEqual({ x: 2, y: 0, z: 0 });
  });

  it("bounces, squashes on impact, then floats at its hover", () => {
    expect(restAt(0).squash).toBeCloseTo(LOOT.squash);
    expect(restAt(LOOT.bounces[0][1] / 2).y).toBeCloseTo(LOOT.bounces[0][0]);
    const rested = restAt(SETTLE_MS);
    expect(rested.squash).toBe(0);
    expect(Math.abs(rested.y - LOOT.hover)).toBeLessThanOrEqual(LOOT.bob);
  });
});

it("rarity sets the tier", () => {
  expect(tierOf("common")).toBe(0);
  expect(tierOf("mythic")).toBe(4);
});
