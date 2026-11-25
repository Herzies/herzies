import { describe, expect, it } from "vitest";
import { pickWeightedDrop } from "./items.js";
import {
  attackTokens,
  crossedStats,
  describeTowerBoon,
  floorKinds,
  gapColour,
  isChestFloor,
  isEliteFloor,
  isWardenFloor,
  levelGapMods,
  mobsOnFloor,
  TOWER_BOON_RARITIES,
  TOWER_DROP_CHANCE,
  TOWER_DROPS_DAILY_CAP,
  TOWER_RARE_LEAN,
  towerBoonOffers,
  towerBoonPickFloor,
  towerBoonPicks,
  towerBoonTotals,
  towerChestRolls,
  towerLootLean,
  towerMob,
  towerRareFactor,
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

describe("tower loot", () => {
  it("leans rarer floor by floor, gently, up to a cap", () => {
    expect(towerRareFactor(1)).toBe(1);
    expect(towerRareFactor(0)).toBe(1);
    expect(towerRareFactor(Number.NaN)).toBe(1);
    let last = 1;
    for (let f = 2; f <= 200; f++) {
      const r = towerRareFactor(f);
      expect(r).toBeGreaterThanOrEqual(last);
      expect(r).toBeLessThanOrEqual(1 + TOWER_RARE_LEAN.cap);
      last = r;
    }
    expect(towerRareFactor(11)).toBeCloseTo(1.1);
    expect(towerRareFactor(51)).toBeCloseTo(1 + TOWER_RARE_LEAN.cap);
    expect(towerRareFactor(500)).toBe(towerRareFactor(51));
  });

  it("leans only rare and up; a chest leans further", () => {
    const kill = towerLootLean(31);
    expect(kill.common).toBe(1);
    expect(kill.uncommon).toBe(1);
    expect(kill.rare).toBeCloseTo(1.3);
    expect(kill.mythic).toBe(kill.rare);
    const chest = towerLootLean(31, true);
    for (const r of ["uncommon", "rare", "legendary", "mythic"] as const)
      expect(chest[r]).toBeGreaterThan(kill[r]);
  });

  it("makes a rare likelier higher up", () => {
    const pool = [
      { id: "a", rarity: "common" as const },
      { id: "b", rarity: "uncommon" as const },
      { id: "c", rarity: "rare" as const },
    ];
    // Weights 1000 / 150 / 25: this roll lands on the uncommon's end on
    // floor 1 (1145.6 of 1175), and past it once the rare's weight grows
    // by half (1157.8 of 1187.5).
    const roll = () => 0.975;
    expect(pickWeightedDrop(pool, 0, roll, towerLootLean(1))?.id).toBe("b");
    expect(pickWeightedDrop(pool, 0, roll, towerLootLean(60))?.id).toBe("c");
  });

  it("leaves a chest every 10th floor, fuller higher up", () => {
    expect([0, 1, 5, 9, 11, 15, 25].some(isChestFloor)).toBe(false);
    expect([10, 20, 30, 100].every(isChestFloor)).toBe(true);
    expect(towerChestRolls(10)).toBe(2);
    expect(towerChestRolls(20)).toBe(3);
    expect(towerChestRolls(40)).toBe(4);
    expect(towerChestRolls(200)).toBe(4);
  });
});

describe("tower boon offers", () => {
  it("offers different boons, the same ones again for the same seed", () => {
    const a = towerBoonOffers("u:e:1:0", 5);
    expect(new Set(a.map((b) => b.id)).size).toBe(a.length);
    expect(towerBoonOffers("u:e:1:0", 5)).toEqual(a);
  });

  it("leans rarer the higher the floor", () => {
    const rareShare = (floor: number) => {
      let rare = 0;
      let all = 0;
      for (let i = 0; i < 2000; i++)
        for (const b of towerBoonOffers(`s${i}`, floor)) {
          all++;
          if (TOWER_BOON_RARITIES.indexOf(b.rarity) >= 2) rare++;
        }
      return rare / all;
    };
    expect(rareShare(5)).toBeLessThan(0.2);
    expect(rareShare(60)).toBeGreaterThan(0.6);
  });
});

describe("tower boon picks", () => {
  it("one a floor at first, then every 2nd, 3rd and 5th floor", () => {
    const picks = (c: number) => towerBoonPicks(c);
    expect([0, 1, 5, 6, 7, 15, 17, 18, 30, 34, 35, 60, 100].map(picks)).toEqual(
      [0, 1, 5, 5, 6, 10, 10, 11, 15, 15, 16, 21, 29],
    );
  });

  it("each pick's floor is the one that earns it", () => {
    for (let n = 1; n <= 40; n++) {
      const floor = towerBoonPickFloor(n);
      expect(towerBoonPicks(floor)).toBe(n);
      expect(towerBoonPicks(floor - 1)).toBe(n - 1);
    }
  });
});

describe("tower boons", () => {
  it("a trade-off says its cost: Glass Cannon's damage taken is half its bonus", () => {
    expect(describeTowerBoon({ id: "glass-cannon", rarity: "mythic" })).toBe(
      "Hits 40% harder, but mobs hit you 20% harder.",
    );
  });

  it("Crossover moves Euphony to Sonic Power point for point, never more than there is", () => {
    const stats = { sonicPower: 10, euphony: 80, def: 5 };
    expect(crossedStats(stats, 0.25)).toEqual({
      sonicPower: 30,
      euphony: 60,
      def: 5,
    });
    const all = [1, 2, 3].map(
      () => ({ id: "crossover", rarity: "mythic" }) as const,
    );
    const share = towerBoonTotals(all).crossover;
    expect(share).toBe(1);
    expect(crossedStats(stats, share)).toMatchObject({
      sonicPower: 90,
      euphony: 0,
    });
    expect(crossedStats(stats, 0)).toBe(stats);
  });
});
