import { describe, expect, it } from "vitest";
import { waveDamage } from "./combat.js";
import {
  buffMult,
  defReduction,
  healMult,
  levelStats,
  normalizeStatPoints,
  statPoints,
  validateAllocation,
} from "./stats.js";
import { maxHp } from "./vitals.js";

describe("statPoints", () => {
  it("earns two a level after the first and counts what's left", () => {
    expect(statPoints(1, null)).toEqual({ total: 0, spent: 0, unspent: 0 });
    expect(statPoints(34, null)).toEqual({ total: 66, spent: 0, unspent: 66 });
    expect(statPoints(10, { stamina: 5, sonicPower: 3, euphony: 2 })).toEqual({
      total: 18,
      spent: 10,
      unspent: 8,
    });
  });

  it("never reports less than nothing left", () => {
    expect(
      statPoints(1, { stamina: 9, sonicPower: 0, euphony: 0 }).unspent,
    ).toBe(0);
  });

  it("reads junk as 0", () => {
    expect(normalizeStatPoints({ stamina: -3, sonicPower: "x" })).toEqual({
      stamina: 0,
      sonicPower: 0,
      euphony: 0,
    });
  });
});

describe("validateAllocation", () => {
  it("takes up to the level's points, and a reset", () => {
    expect(
      validateAllocation(10, { stamina: 18, sonicPower: 0, euphony: 0 }),
    ).toBeNull();
    expect(
      validateAllocation(10, { stamina: 0, sonicPower: 0, euphony: 0 }),
    ).toBeNull();
  });

  it("refuses too many, negatives and fractions", () => {
    expect(
      validateAllocation(10, { stamina: 15, sonicPower: 4, euphony: 0 }),
    ).not.toBeNull();
    expect(
      validateAllocation(1, { stamina: 1, sonicPower: 0, euphony: 0 }),
    ).not.toBeNull();
    expect(
      validateAllocation(10, { stamina: -1, sonicPower: 0, euphony: 0 }),
    ).not.toBeNull();
    expect(
      validateAllocation(10, { stamina: 1.5, sonicPower: 0, euphony: 0 }),
    ).not.toBeNull();
  });
});

describe("what the stats do", () => {
  it("Def takes off a share that grows slower and slower", () => {
    expect(defReduction(0)).toBe(0);
    expect(defReduction(100)).toBe(0.5);
    expect(defReduction(34)).toBeCloseTo(0.254, 3);
    expect(defReduction(-5)).toBe(0);
  });

  it("Euphony strengthens heals more than buffs", () => {
    expect(healMult(0)).toBe(1);
    expect(healMult(34)).toBeCloseTo(1.34);
    expect(buffMult(34)).toBeCloseTo(1.17);
  });

  it("Stamina adds max HP", () => {
    expect(maxHp(34, 0)).toBe(374);
    expect(maxHp(34, 34)).toBe(714);
    expect(maxHp(34, -2)).toBe(374);
  });

  it("every level adds a little HP, Sonic Power and Def on its own", () => {
    // The matrix the curve was picked from (level → HP, Def, wave base).
    const rows: [number, number, number, number][] = [
      [1, 110, 0, 100],
      [5, 142, 2.4, 108],
      [10, 182, 5.4, 118],
      [20, 262, 11.4, 138],
      [30, 342, 17.4, 158],
      [50, 502, 29.4, 198],
    ];
    for (const [level, hp, def, atk] of rows) {
      expect(maxHp(level)).toBe(hp);
      const s = levelStats(level);
      expect(s.def).toBeCloseTo(def);
      expect(waveDamage(s.sonicPower)).toBe(atk);
    }
    expect(levelStats(0)).toEqual(levelStats(1));
  });
});

describe("waveDamage", () => {
  it("is the base hit raised by sonic power", () => {
    expect(waveDamage(0)).toBe(100);
    expect(waveDamage(34)).toBe(134);
  });
});
