import { describe, expect, it } from "vitest";
import { CLASS_DEFS, CLASS_IDS, needsClassChoice } from "./classes.js";
import { getItem } from "./items.js";
import {
  applyBuff,
  applySkillXp,
  buffReductions,
  describeSkill,
  MAX_DAMAGE_REDUCTION,
  mitigate,
  SHUFFLE_FALLOFF,
  SKILL_IDS,
  SKILL_MAX_LEVEL,
  shuffleBounces,
  shuffleScale,
  skillLevelForXp,
  skillLevelProgress,
  skillTotalXpForLevel,
  skillValue,
} from "./skills.js";

describe("skillValue", () => {
  it("runs linearly from the level 1 value to the level 10 value", () => {
    expect(skillValue("soothing-drones", 1)).toBeCloseTo(0.2);
    expect(skillValue("soothing-drones", 10)).toBeCloseTo(0.5);
    expect(skillValue("rimshot", 1)).toBeCloseTo(0.25);
    expect(skillValue("rimshot", 10)).toBeCloseTo(0.5);
    expect(skillValue("cymbrella", 1)).toBeCloseTo(3);
    expect(skillValue("cymbrella", 10)).toBeCloseTo(5);
  });

  it("clamps out-of-range levels", () => {
    expect(skillValue("backspin", 0)).toBe(skillValue("backspin", 1));
    expect(skillValue("backspin", 99)).toBe(skillValue("backspin", 10));
    expect(skillValue("backspin", Number.NaN)).toBe(skillValue("backspin", 1));
  });
});

describe("skill XP", () => {
  it("takes about 2,500 XP to go from 1 to 10", () => {
    const total = skillTotalXpForLevel(SKILL_MAX_LEVEL);
    expect(total).toBeGreaterThan(2000);
    expect(total).toBeLessThan(3000);
  });

  it("levels up as XP crosses each threshold", () => {
    expect(skillLevelForXp(0)).toBe(1);
    expect(skillLevelForXp(skillTotalXpForLevel(2) - 1)).toBe(1);
    expect(skillLevelForXp(skillTotalXpForLevel(2))).toBe(2);
    const r = applySkillXp({ level: 1, xp: 0 }, skillTotalXpForLevel(3));
    expect(r).toEqual({
      level: 3,
      xp: skillTotalXpForLevel(3),
      leveledUp: true,
    });
  });

  it("caps at the max level but keeps counting XP", () => {
    const r = applySkillXp({ level: 1, xp: 0 }, 1_000_000);
    expect(r.level).toBe(SKILL_MAX_LEVEL);
    expect(r.xp).toBe(1_000_000);
    expect(skillLevelProgress(r)).toBe(1);
  });

  it("ignores negative and fractional gains", () => {
    expect(applySkillXp({ level: 1, xp: 10 }, -50)).toEqual({
      level: 1,
      xp: 10,
      leveledUp: false,
    });
    expect(applySkillXp({ level: 1, xp: 10 }, 2.9).xp).toBe(12);
  });
});

describe("buffs", () => {
  it("doesn't stack the same buff: stronger value, later expiry", () => {
    let buffs = applyBuff([], { id: "cymbrella", value: 0.4, until: 1000 });
    buffs = applyBuff(buffs, { id: "cymbrella", value: 0.1, until: 5000 });
    expect(buffs).toEqual([{ id: "cymbrella", value: 0.4, until: 5000 }]);
  });
});

describe("mitigate", () => {
  it("multiplies reductions instead of adding them", () => {
    expect(mitigate(100, [0.5, 0.5])).toBeCloseTo(25);
  });

  it("never takes off more than the cap", () => {
    expect(mitigate(100, [0.9, 0.9])).toBeCloseTo(
      100 * (1 - MAX_DAMAGE_REDUCTION),
    );
    expect(mitigate(100, [2])).toBeCloseTo(100 * (1 - MAX_DAMAGE_REDUCTION));
  });

  it("leaves damage alone with no reductions", () => {
    expect(mitigate(100, [])).toBe(100);
  });
});

describe("classes", () => {
  it("each class starts with a real skill and owns real items", () => {
    for (const id of CLASS_IDS) {
      const def = CLASS_DEFS[id];
      expect(SKILL_IDS).toContain(def.starterSkill);
      for (const itemId of def.equipment) {
        expect(getItem(itemId)?.requiredClass).toBe(id);
      }
    }
  });

  it("asks for a class from stage 2 until one is picked", () => {
    expect(needsClassChoice({ stage: 1, class: null })).toBe(false);
    expect(needsClassChoice({ stage: 2, class: null })).toBe(true);
    expect(needsClassChoice({ stage: 3 })).toBe(true);
    expect(needsClassChoice({ stage: 3, class: "bard" })).toBe(false);
  });
});

describe("Shuffle", () => {
  it("bounces once at level 1, one more every two levels, 5 at the cap", () => {
    const by = Array.from({ length: 10 }, (_, i) => shuffleBounces(i + 1));
    expect(by).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it("each bounce is weaker than the last", () => {
    expect(shuffleScale(0)).toBe(1);
    expect(shuffleScale(1)).toBeCloseTo(SHUFFLE_FALLOFF);
    expect(shuffleScale(2)).toBeCloseTo(SHUFFLE_FALLOFF ** 2);
  });

  it("says how many it bounces to, in words", () => {
    expect(describeSkill("shuffle", 1)).toContain("1 more enemy nearby");
    expect(describeSkill("shuffle", 10)).toContain("5 more enemies nearby");
  });
});

describe("the Percussionist's kit", () => {
  it("says how long the dome stands, and Rimshot's chance", () => {
    expect(describeSkill("cymbrella", 1)).toContain("for 3 seconds");
    expect(describeSkill("cymbrella", 10)).toContain("for 5 seconds");
    expect(describeSkill("rimshot", 1)).toContain("25% chance");
  });

  it("a Cymbrella no longer cuts damage as a buff (the dome does it)", () => {
    expect(
      buffReductions([{ id: "cymbrella", value: 1, until: 1_000 }], 0),
    ).toEqual([]);
  });
});
