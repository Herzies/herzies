import { describe, expect, it } from "vitest";
import {
  applyXp,
  calculateXpGain,
  levelProgress,
  stageForLevel,
  totalXpForLevel,
  xpForLevel,
  xpToNextLevel,
} from "./leveling.js";
import type { Herzie } from "./types.js";

function makeHerzie(overrides: Partial<Herzie> = {}): Herzie {
  return {
    id: "test-id",
    name: "Test",
    createdAt: "2026-01-01",
    appearance: {
      headIndex: 0,
      eyesIndex: 0,
      mouthIndex: 0,
      accessoryIndex: 0,
      limbsIndex: 0,
      bodyIndex: 0,
      legsIndex: 0,
      colorScheme: "pink",
    },
    xp: 0,
    level: 1,
    stage: 1,
    totalMinutesListened: 0,
    genreMinutes: {},
    friendCode: "HERZ-TEST",
    friendCodes: [],
    lastCravingDate: "",
    lastCravingGenre: "",
    streakDays: 0,
    streakLastDate: null,
    currency: 0,
    ...overrides,
  };
}

describe("xpForLevel", () => {
  it("returns base XP for level 1", () => {
    expect(xpForLevel(1)).toBe(Math.floor(100 * 1 ** 1.5));
  });

  it("scales with level", () => {
    expect(xpForLevel(10)).toBe(Math.floor(100 * 10 ** 1.5));
  });

  it("increases monotonically", () => {
    for (let i = 1; i < 50; i++) {
      expect(xpForLevel(i + 1)).toBeGreaterThan(xpForLevel(i));
    }
  });
});

describe("totalXpForLevel", () => {
  it("returns 0 for level 1 (no XP needed to be level 1)", () => {
    expect(totalXpForLevel(1)).toBe(0);
  });

  it("returns xpForLevel(2) for level 2", () => {
    expect(totalXpForLevel(2)).toBe(xpForLevel(2));
  });

  it("is cumulative sum", () => {
    expect(totalXpForLevel(4)).toBe(
      xpForLevel(2) + xpForLevel(3) + xpForLevel(4),
    );
  });
});

describe("xpToNextLevel", () => {
  it("returns full amount for a fresh level 1 herzie", () => {
    const h = makeHerzie({ xp: 0, level: 1 });
    expect(xpToNextLevel(h)).toBe(xpForLevel(2));
  });

  it("decreases as xp increases", () => {
    const h = makeHerzie({ xp: 100, level: 1 });
    expect(xpToNextLevel(h)).toBe(xpForLevel(2) - 100);
  });
});

describe("levelProgress", () => {
  it("returns 0 at start of level", () => {
    const h = makeHerzie({ xp: totalXpForLevel(5), level: 5 });
    expect(levelProgress(h)).toBe(0);
  });

  it("returns value between 0 and 1", () => {
    const h = makeHerzie({ xp: totalXpForLevel(5) + 50, level: 5 });
    const progress = levelProgress(h);
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThanOrEqual(1);
  });
});

describe("stageForLevel", () => {
  it("returns stage 1 for levels 1-9", () => {
    for (let l = 1; l <= 9; l++) {
      expect(stageForLevel(l)).toBe(1);
    }
  });

  it("returns stage 2 for levels 10-24", () => {
    for (let l = 10; l <= 24; l++) {
      expect(stageForLevel(l)).toBe(2);
    }
  });

  it("returns stage 3 for level 25+", () => {
    expect(stageForLevel(25)).toBe(3);
    expect(stageForLevel(50)).toBe(3);
    expect(stageForLevel(100)).toBe(3);
  });
});

describe("calculateXpGain", () => {
  it("returns base XP for 1 minute with no bonuses", () => {
    expect(calculateXpGain(1, 0, false, [])).toBe(10);
  });

  it("scales linearly with minutes", () => {
    expect(calculateXpGain(5, 0, false, [])).toBe(50);
  });

  it("applies craving bonus (1.5x)", () => {
    expect(calculateXpGain(1, 0, true, [])).toBe(15);
  });

  it("applies friend bonus capped at 20 friends", () => {
    const with10 = calculateXpGain(1, 10, false, []);
    const with20 = calculateXpGain(1, 20, false, []);
    const with30 = calculateXpGain(1, 30, false, []); // capped at 20
    expect(with10).toBe(10 * (1 + 10 * 0.02));
    expect(with20).toBe(10 * (1 + 20 * 0.02));
    expect(with30).toBe(with20); // cap at 20
  });

  it("applies multipliers", () => {
    const multipliers = [{ name: "test", bonus: 1.0 }]; // +100%
    const xp = calculateXpGain(1, 0, false, multipliers);
    expect(xp).toBe(20); // 10 * (1 + 1.0)
  });

  it("stacks craving and multipliers", () => {
    const multipliers = [{ name: "test", bonus: 1.0 }];
    const xp = calculateXpGain(1, 0, true, multipliers);
    expect(xp).toBe(30); // 10 * 1.5 craving * 2.0 multiplier
  });
});

describe("applyXp", () => {
  it("does not level up with insufficient XP", () => {
    const h = makeHerzie({ xp: 0, level: 1 });
    const result = applyXp(h, 10);
    expect(result.leveledUp).toBe(false);
    expect(h.level).toBe(1);
    expect(h.xp).toBe(10);
  });

  it("levels up when XP threshold is reached", () => {
    const h = makeHerzie({ xp: 0, level: 1 });
    const needed = xpForLevel(2);
    const result = applyXp(h, needed);
    expect(result.leveledUp).toBe(true);
    expect(h.level).toBe(2);
  });

  it("handles multi-level jump", () => {
    const h = makeHerzie({ xp: 0, level: 1 });
    const result = applyXp(h, 100000);
    expect(result.leveledUp).toBe(true);
    expect(h.level).toBeGreaterThan(5);
  });

  it("triggers evolution at level 10", () => {
    const h = makeHerzie({ xp: totalXpForLevel(9), level: 9, stage: 1 });
    const needed = xpForLevel(10);
    const result = applyXp(h, needed);
    expect(result.evolved).toBe(true);
    expect(result.newStage).toBe(2);
    expect(h.stage).toBe(2);
  });

  it("triggers evolution at level 25", () => {
    const h = makeHerzie({ xp: totalXpForLevel(24), level: 24, stage: 2 });
    const needed = xpForLevel(25);
    const result = applyXp(h, needed);
    expect(result.evolved).toBe(true);
    expect(result.newStage).toBe(3);
    expect(h.stage).toBe(3);
  });

  it("does not evolve within the same stage", () => {
    const h = makeHerzie({ xp: totalXpForLevel(5), level: 5, stage: 1 });
    const result = applyXp(h, xpForLevel(6));
    expect(result.leveledUp).toBe(true);
    expect(result.evolved).toBe(false);
  });
});
