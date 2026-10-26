import { describe, expect, it } from "vitest";
import {
  BOSS_ENRAGE,
  BOSS_HP_PER_PLAYER,
  BOSS_WANDER,
  bossMaxHp,
  clampToWander,
  enrageFactor,
  inTuneBonus,
  minionPackSize,
  parseTune,
  weightedRound,
} from "./boss-fight.js";
import { BOSS_LINES, bossLine, bossLineMs } from "./boss-lines.js";

describe("the boss's health", () => {
  it("grows with the roster, a little slower than it", () => {
    expect(bossMaxHp(1)).toBe(BOSS_HP_PER_PLAYER);
    for (const n of [2, 5, 12, 40]) {
      expect(bossMaxHp(n)).toBeGreaterThan(bossMaxHp(n - 1));
      // Per herzie, a bigger roster faces a little less.
      expect(bossMaxHp(n) / n).toBeLessThan(bossMaxHp(n - 1) / (n - 1));
    }
  });

  it("takes the event's own health per herzie", () => {
    expect(bossMaxHp(3, 10_000)).toBe(Math.round(10_000 * 3 ** 0.9));
  });

  it("counts nobody as one", () => {
    expect(bossMaxHp(0)).toBe(bossMaxHp(1));
  });
});

describe("weightedRound", () => {
  it("rounds up as often as the fraction says, with no breakpoint", () => {
    let seq = 0;
    const rand = () => (seq++ % 10) / 10;
    let ups = 0;
    for (let i = 0; i < 1_000; i++) ups += weightedRound(2.3, rand) - 2;
    expect(ups).toBe(300);
    expect(weightedRound(3, () => 0.99)).toBe(3);
  });

  it("sizes a minion pack between two and eight", () => {
    expect(minionPackSize(1, () => 0)).toBe(2);
    expect(minionPackSize(40, () => 0)).toBe(8);
    expect(minionPackSize(9, () => 0.99)).toBe(4);
    expect(minionPackSize(9, () => 0)).toBe(5);
  });
});

describe("the boss's walk", () => {
  it("is kept inside its circle", () => {
    const far = clampToWander({ x: 40, z: 40 });
    expect(
      Math.hypot(far.x - BOSS_WANDER.x, far.z - BOSS_WANDER.z),
    ).toBeCloseTo(BOSS_WANDER.radius);
    expect(clampToWander({ x: 0, z: -2 })).toEqual({ x: 0, z: -2 });
  });

  it("never reaches the spawn", () => {
    const toward = clampToWander({ x: 0, z: 10 });
    expect(10 - toward.z).toBeGreaterThan(4);
  });
});

describe("the enrage", () => {
  it("is nothing until the soft enrage, then compounds", () => {
    expect(enrageFactor(BOSS_ENRAGE.softMs - 1)).toBe(1);
    expect(enrageFactor(BOSS_ENRAGE.softMs)).toBeCloseTo(1 + BOSS_ENRAGE.step);
    expect(enrageFactor(BOSS_ENRAGE.softMs + BOSS_ENRAGE.stepMs)).toBeCloseTo(
      (1 + BOSS_ENRAGE.step) ** 2,
    );
    expect(BOSS_ENRAGE.hardMs).toBeGreaterThan(BOSS_ENRAGE.softMs);
  });
});

describe("the music it hates", () => {
  it("gives each class its own bonus, and a classless herzie none", () => {
    expect(inTuneBonus("percussionist")?.kind).toBe("def");
    expect(inTuneBonus("bard")?.kind).toBe("heal");
    expect(inTuneBonus("record_slinger")?.kind).toBe("damage");
    expect(inTuneBonus(null)).toBeNull();
    expect(inTuneBonus("wizard")).toBeNull();
  });

  it("takes only whether music is playing", () => {
    expect(parseTune(true)).toBe(true);
    expect(parseTune(false)).toBe(false);
    expect(parseTune("metal")).toBeNull();
    expect(parseTune(null)).toBeNull();
  });
});

describe("the boss's lines", () => {
  it("have something to say for every moment, never a placeholder", () => {
    for (const kind of Object.keys(BOSS_LINES) as (keyof typeof BOSS_LINES)[]) {
      for (let i = 0; i < 10; i++) {
        const line = bossLine(kind, () => i / 10);
        expect(line.length).toBeGreaterThan(0);
        expect(line).not.toMatch(/[{}]/);
      }
    }
    expect(bossLine("remind", () => 0.21)).toBe("Music? In MY cave?");
  });

  it("stay up long enough to read, not forever", () => {
    expect(bossLineMs("Hi")).toBeGreaterThan(2_000);
    expect(bossLineMs("x".repeat(500))).toBeLessThanOrEqual(7_000);
  });
});
