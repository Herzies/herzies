import { describe, expect, it } from "vitest";
import {
  BENCH_REGEN_MULT,
  benchBonusHp,
  effectiveHp,
  HP_REGEN_DELAY_MS,
  liveHp,
  maxHp,
  respawnHp,
  vitalsOf,
} from "./vitals.js";

const T = 1_700_000_000_000;

describe("maxHp", () => {
  it("grows with level and tolerates junk", () => {
    expect(maxHp(1)).toBe(105);
    expect(maxHp(100)).toBe(600);
    expect(maxHp(0)).toBe(maxHp(1));
    expect(maxHp(Number.NaN)).toBe(maxHp(1));
  });
});

describe("effectiveHp", () => {
  it("is full when never written", () => {
    expect(effectiveHp({ hp: null, hpAt: null, down: false }, 200, T)).toBe(
      200,
    );
  });

  it("holds still for the regen delay, then climbs", () => {
    const row = { hp: 50, hpAt: T, down: false };
    expect(effectiveHp(row, 300, T + HP_REGEN_DELAY_MS)).toBe(50);
    // 300 max, 1/300 of it a second: one HP per second after the delay.
    expect(effectiveHp(row, 300, T + HP_REGEN_DELAY_MS + 10_000)).toBeCloseTo(
      60,
    );
  });

  it("never exceeds max", () => {
    const row = { hp: 290, hpAt: T, down: false };
    expect(effectiveHp(row, 300, T + 3_600_000)).toBe(300);
  });

  it("does not regen while down", () => {
    const row = { hp: 0, hpAt: T, down: true };
    expect(effectiveHp(row, 300, T + 3_600_000)).toBe(0);
  });

  it("a full bar takes about five minutes from empty", () => {
    const row = { hp: 0, hpAt: T, down: false };
    expect(effectiveHp(row, 300, T + HP_REGEN_DELAY_MS + 300_000)).toBeCloseTo(
      300,
    );
  });
});

describe("benchBonusHp", () => {
  it("adds up to the bench speed on top of base regen", () => {
    const base = 300 * (1 / 300) * 90; // 90s of base regen
    expect(base + benchBonusHp(300, 90)).toBeCloseTo(300);
    expect(BENCH_REGEN_MULT).toBeGreaterThan(1);
    expect(benchBonusHp(300, -5)).toBe(0);
  });
});

describe("respawnHp", () => {
  it("is half, rounded up", () => {
    expect(respawnHp(200)).toBe(100);
    expect(respawnHp(105)).toBe(53);
  });
});

describe("vitalsOf / liveHp", () => {
  it("a client keeps counting regen from the handed-out stamp", () => {
    const v = vitalsOf({ hp: 20, hpAt: T, down: false }, 59, T);
    expect(v.maxHp).toBe(395);
    expect(v.hp).toBe(20);
    expect(liveHp(v, T + HP_REGEN_DELAY_MS + 60_000)).toBeCloseTo(20 + 395 / 5);
  });
});
