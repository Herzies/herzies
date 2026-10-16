import { describe, expect, it } from "vitest";
import {
  gapColour,
  levelGapMods,
  mobsOnFloor,
  TOWER_DROP_CHANCE,
  towerMob,
  towerXpPerKill,
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
    expect(mobsOnFloor(100)).toBe(10);
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

  it("pays less than listening", () => {
    // About three kills a minute against listening's 10 XP and 0.1 drops.
    for (const f of [1, 10, 30]) {
      expect(towerXpPerKill(f) * 3).toBeLessThan(10);
    }
    expect(TOWER_DROP_CHANCE * 3).toBeLessThanOrEqual(0.12);
  });
});
