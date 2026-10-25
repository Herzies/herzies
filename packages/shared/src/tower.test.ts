import { describe, expect, it } from "vitest";
import {
  attackTokens,
  floorKinds,
  gapColour,
  isEliteFloor,
  isWardenFloor,
  levelGapMods,
  mobsOnFloor,
  TOWER_DROP_CHANCE,
  TOWER_DROPS_DAILY_CAP,
  towerMob,
  towerXpPerKill,
  windupScale,
} from "./tower.js";

describe("tower curves", () => {
  it("grows every floor, then levels off", () => {
    let last = towerMob(1);
    expect(last).toEqual({ level: 1, hp: 300, damage: 8 });
    for (let f = 2; f <= 80; f++) {
      const m = towerMob(f);
      expect(m.hp).toBeGreaterThan(last.hp);
      expect(m.damage).toBeGreaterThanOrEqual(last.damage);
      last = m;
    }
    expect(towerMob(500).hp).toBe(towerMob(80).hp);
    expect(towerMob(500).level).toBe(500);
  });

  it("adds mobs slowly, up to ten", () => {
    expect(mobsOnFloor(1)).toBe(3);
    expect(mobsOnFloor(4)).toBe(5);
    expect(mobsOnFloor(99)).toBe(10);
    // The Warden's floors: half a pack, him among them.
    expect(mobsOnFloor(100)).toBe(5);
  });

  it("mixes in spitters, then lungers, a quarter each", () => {
    expect(floorKinds(1)).toEqual(["brute", "brute", "brute"]);
    expect(floorKinds(2).filter((k) => k === "spitter")).toHaveLength(1);
    expect(floorKinds(3).includes("lunger")).toBe(false);
    const f20 = floorKinds(21);
    expect(f20).toHaveLength(mobsOnFloor(21));
    expect(f20.filter((k) => k === "lunger")).toHaveLength(2);
  });

  it("tightens tells and adds attackers the higher you go, within bounds", () => {
    expect(windupScale(1)).toBe(1);
    expect(windupScale(200)).toBe(0.65);
    expect(attackTokens(1)).toBe(2);
    expect(attackTokens(25)).toBe(4);
    expect(attackTokens(200)).toBe(4);
    expect(isWardenFloor(10)).toBe(true);
    expect(isEliteFloor(10)).toBe(false);
    expect(isEliteFloor(15)).toBe(true);
  });

  it("makes higher mobs tougher and lower ones easier, within bounds", () => {
    expect(levelGapMods(0)).toEqual({ dealt: 1, taken: 1 });
    const above = levelGapMods(10);
    expect(above.dealt).toBeCloseTo(0.6);
    expect(above.taken).toBeCloseTo(1.5);
    expect(levelGapMods(100)).toEqual({ dealt: 0.3, taken: 2 });
    expect(levelGapMods(-100)).toEqual({ dealt: 1.2, taken: 0.6 });
    expect(levelGapMods(Number.NaN)).toEqual({ dealt: 1, taken: 1 });
  });

  it("colours the gap", () => {
    expect(gapColour(-10)).toBe("grey");
    expect(gapColour(0)).toBe("white");
    expect(gapColour(4)).toBe("orange");
    expect(gapColour(9)).toBe("red");
  });

  it("pays less XP than listening, and drops under a daily cap", () => {
    // About three kills a minute against listening's 10 XP.
    for (const f of [1, 10, 30]) {
      expect(towerXpPerKill(f) * 3).toBeLessThan(10);
    }
    expect(TOWER_DROP_CHANCE).toBeLessThanOrEqual(1 / 8);
    expect(TOWER_DROPS_DAILY_CAP).toBeLessThanOrEqual(30);
  });
});
