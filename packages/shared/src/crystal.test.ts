import { describe, expect, it } from "vitest";
import {
  CRYSTAL_MAX_TIER,
  canAttune,
  chargeCrystal,
  crystalCapacity,
  crystalDropsWaiting,
  crystalStateFromRow,
  crystalThresholdsCrossed,
  crystalUpgradeCost,
} from "./crystal.js";

describe("crystalCapacity", () => {
  it("is 3h at tier 0 and grows 1h per tier up to 8h", () => {
    expect(crystalCapacity(0)).toBe(180);
    expect(crystalCapacity(1)).toBe(240);
    expect(crystalCapacity(CRYSTAL_MAX_TIER)).toBe(480);
  });
  it("clamps bad tiers", () => {
    expect(crystalCapacity(-3)).toBe(180);
    expect(crystalCapacity(99)).toBe(480);
    expect(crystalCapacity(null)).toBe(180);
  });
});

describe("crystalUpgradeCost", () => {
  it("rises per tier and is null at the top", () => {
    const costs = [0, 1, 2, 3, 4].map((t) => crystalUpgradeCost(t));
    expect(costs).toEqual([3, 5, 8, 12, 20]);
    expect(crystalUpgradeCost(CRYSTAL_MAX_TIER)).toBeNull();
  });
});

describe("chargeCrystal", () => {
  it("counts minutes in full under capacity", () => {
    expect(chargeCrystal(0, 10, 0)).toEqual({
      effectiveMinutes: 10,
      newFill: 10,
    });
  });
  it("splits a charge that crosses capacity", () => {
    // 5 minutes fit, 5 overflow at 25%.
    expect(chargeCrystal(175, 10, 0)).toEqual({
      effectiveMinutes: 6.25,
      newFill: 185,
    });
  });
  it("keeps charging past capacity, slower, never zero", () => {
    expect(chargeCrystal(600, 8, 0)).toEqual({
      effectiveMinutes: 2,
      newFill: 608,
    });
  });
  it("an 8h night on a fresh tier-0 Crystal yields 3h + a quarter of the rest", () => {
    let fill = 0;
    let effective = 0;
    for (let i = 0; i < 48; i++) {
      const c = chargeCrystal(fill, 10, 0);
      fill = c.newFill;
      effective += c.effectiveMinutes;
    }
    expect(fill).toBe(480);
    expect(effective).toBe(180 + 300 * 0.25);
  });
  it("ignores negative input", () => {
    expect(chargeCrystal(-5, -5, 0)).toEqual({
      effectiveMinutes: 0,
      newFill: 0,
    });
  });
});

describe("crystalThresholdsCrossed", () => {
  it("fires nearly-full once at 90%", () => {
    expect(crystalThresholdsCrossed(160, 165, 0)).toEqual({
      nearlyFull: true,
      full: false,
    });
    expect(crystalThresholdsCrossed(165, 170, 0).nearlyFull).toBe(false);
  });
  it("fires full once, and skips nearly-full when a charge jumps straight past", () => {
    expect(crystalThresholdsCrossed(160, 190, 0)).toEqual({
      nearlyFull: false,
      full: true,
    });
    expect(crystalThresholdsCrossed(190, 200, 0).full).toBe(false);
  });
});

describe("crystalDropsWaiting / crystalStateFromRow", () => {
  it("one drop per 10 charged minutes", () => {
    expect(crystalDropsWaiting(39.9)).toBe(3);
    expect(crystalDropsWaiting(0)).toBe(0);
  });
  it("reads a row", () => {
    expect(
      crystalStateFromRow(
        {
          crystal_fill: "200",
          crystal_xp: "1234.7",
          crystal_drop_minutes: "45",
          crystal_tier: 1,
          crystal_attunes: 3,
          crystal_shards: 7,
        },
        true,
      ),
    ).toEqual({
      fill: 200,
      capacity: 240,
      xp: 1234,
      dropsWaiting: 4,
      tier: 1,
      attunes: 3,
      shards: 7,
      enabled: true,
    });
  });
});

describe("canAttune", () => {
  const base = crystalStateFromRow({}, true);
  it("needs a minute of listening", () => {
    expect(canAttune({ ...base, fill: 0.5, xp: 5 })).toBe(false);
    expect(canAttune({ ...base, fill: 1, xp: 10 })).toBe(true);
  });
  it("finds left over from a full ground still count", () => {
    expect(canAttune({ ...base, fill: 0, dropsWaiting: 2 })).toBe(true);
  });
  it("never while the Crystal is off", () => {
    expect(canAttune({ ...base, enabled: false, fill: 100 })).toBe(false);
  });
});
