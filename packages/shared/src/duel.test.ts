import { describe, expect, it } from "vitest";
import {
  DISC_DAMAGE,
  meleeDamage,
  mitigatedDamage,
  STRIKE_DAMAGE,
} from "./combat.js";
import {
  DUEL,
  DUEL_MAPS,
  duelAttackShare,
  duelCountdownMs,
  duelCredited,
  duelDamage,
  duelMarks,
  duelMaxHp,
  duelRing,
  inDuelRing,
  suddenDeath,
} from "./duel.js";
import { MAX_DAMAGE_REDUCTION } from "./skills.js";
import { TOWN_MAPS, TOWN_TICKETED_MAPS } from "./town-net.js";
import { maxHp } from "./vitals.js";

/** A plain hit: a wave's roll, no Def, in regulation, on a big herzie. */
const hit = {
  amount: 200,
  mult: 1,
  def: 0,
  fightMs: 10_000,
  maxHp: 10_000,
};

describe("duelDamage", () => {
  it("scales a cast's roll and its attack's share down for a herzie", () => {
    expect(duelDamage(hit)).toBe(Math.round(200 * DUEL.damageScale));
    // A Rimshot's two blows: twice a wave.
    expect(duelDamage({ ...hit, mult: 2 })).toBe(
      Math.round(400 * DUEL.damageScale),
    );
  });

  it("takes a share of Def off, and buffs, the way the boss's hits do", () => {
    const def = 300;
    expect(duelDamage({ ...hit, amount: 2_000, def })).toBe(
      Math.round(
        mitigatedDamage(2_000 * DUEL.damageScale, def * DUEL.defScale),
      ),
    );
    // Def counts, but for less than in a fight.
    expect(duelDamage({ ...hit, amount: 2_000, def })).toBeLessThan(
      duelDamage({ ...hit, amount: 2_000 }),
    );
    expect(duelDamage({ ...hit, amount: 2_000, def })).toBeGreaterThan(
      Math.round(mitigatedDamage(2_000 * DUEL.damageScale, def)),
    );
    // However much, never more than the overall clamp.
    const walled = duelDamage({
      ...hit,
      amount: 2_000,
      def: 1e9,
      reductions: [0.5],
    });
    expect(walled).toBe(
      Math.round(2_000 * DUEL.damageScale * (1 - MAX_DAMAGE_REDUCTION)),
    );
  });

  it("hits harder in sudden death, compounding", () => {
    const regulation = duelDamage({ ...hit, amount: 2_000 });
    const first = duelDamage({
      ...hit,
      amount: 2_000,
      fightMs: DUEL.regulationMs,
    });
    const third = duelDamage({
      ...hit,
      amount: 2_000,
      fightMs: DUEL.regulationMs + 2 * DUEL.suddenStepMs,
    });
    expect(first).toBe(
      Math.round(2_000 * DUEL.damageScale * DUEL.suddenDamage),
    );
    expect(first).toBeGreaterThan(regulation);
    expect(third).toBe(
      Math.round(2_000 * DUEL.damageScale * DUEL.suddenDamage ** 3),
    );
  });

  it("never takes more than a share of the victim's health in one hit", () => {
    const huge = duelDamage({ ...hit, amount: 1e6, maxHp: 300 });
    expect(huge).toBe(Math.round(DUEL.maxHitFraction * 300));
  });

  it("always takes at least 1", () => {
    expect(duelDamage({ ...hit, amount: 1, def: 1e9 })).toBe(1);
  });
});

describe("levelling the classes", () => {
  it("gives a duel the level's health, before Stamina", () => {
    expect(duelMaxHp(20)).toBe(maxHp(20));
    expect(duelMaxHp(40)).toBeGreaterThan(duelMaxHp(20));
  });

  it("hits with every basic attack as a wave, a disc a little less", () => {
    expect(duelAttackShare("wave", 0)).toBe(1);
    expect(duelAttackShare("melee", STRIKE_DAMAGE)).toBe(1);
    expect(duelAttackShare("disc", 0)).toBe(DUEL.discShare);
    expect(DUEL.discShare).toBeLessThan(DISC_DAMAGE);
    // Without its instrument, a herzie's punch is still weaker than a stick.
    expect(duelAttackShare("melee", meleeDamage("punch"))).toBeLessThan(1);
  });
});

describe("suddenDeath", () => {
  it("is plain in regulation, then ramps damage up and heals down", () => {
    expect(suddenDeath(0)).toEqual({ damage: 1, heal: 1 });
    expect(suddenDeath(DUEL.regulationMs - 1)).toEqual({ damage: 1, heal: 1 });
    const at = suddenDeath(DUEL.regulationMs + DUEL.suddenStepMs);
    expect(at.damage).toBeCloseTo(DUEL.suddenDamage ** 2);
    expect(at.heal).toBeCloseTo(DUEL.suddenHeal ** 2);
  });
});

describe("the ring", () => {
  it("sits between the two, inside the map", () => {
    expect(duelRing({ x: 0, z: 0 }, { x: 4, z: 0 }, 40)).toEqual({
      x: 2,
      z: 0,
    });
    // Near the edge it's pulled in so the whole ring is on the island.
    const c = duelRing({ x: 38, z: 0 }, { x: 36, z: 0 }, 40);
    expect(c && Math.hypot(c.x, c.z)).toBeCloseTo(40 - DUEL.ringRadius - 1);
    // Too small a map for one.
    expect(
      duelRing({ x: 0, z: 0 }, { x: 1, z: 0 }, DUEL.ringRadius),
    ).toBeNull();
  });

  it("fits on every map duels are fought on, and none of the fights'", () => {
    for (const map of DUEL_MAPS) {
      expect(TOWN_TICKETED_MAPS.has(map)).toBe(false);
      expect(
        duelRing({ x: 0, z: 0 }, { x: 1, z: 0 }, TOWN_MAPS[map].radius),
      ).not.toBeNull();
    }
  });

  it("puts the two on marks either side, apart along their line", () => {
    const centre = { x: 5, z: 5 };
    const m = duelMarks(centre, { x: 4, z: 5 }, { x: 7, z: 5 });
    expect(m.a).toEqual({ x: 5 - DUEL.markRadius, z: 5 });
    expect(m.b).toEqual({ x: 5 + DUEL.markRadius, z: 5 });
    // Standing on the same spot: still two marks.
    const same = duelMarks(centre, centre, centre);
    expect(Math.hypot(same.a.x - same.b.x, same.a.z - same.b.z)).toBeCloseTo(
      2 * DUEL.markRadius,
    );
  });

  it("counts its edge as inside", () => {
    const c = { x: 1, z: 1 };
    expect(inDuelRing(c, { x: 1 + DUEL.ringRadius, z: 1 })).toBe(true);
    expect(inDuelRing(c, { x: 1 + DUEL.ringRadius + 0.01, z: 1 })).toBe(false);
  });
});

describe("duelCountdownMs", () => {
  it("skips the VS card on a rematch", () => {
    expect(duelCountdownMs(true) - duelCountdownMs(false)).toBe(DUEL.introMs);
    expect(duelCountdownMs(false)).toBe(3 * DUEL.countMs);
  });
});

describe("duelCredited", () => {
  const fair = {
    ms: DUEL.creditMs,
    loserDamage: 100,
    winnerMaxHp: 400,
    winnerLevel: 30,
    loserLevel: 25,
  };

  it("counts a real fight between near levels", () => {
    expect(duelCredited(fair)).toBe(true);
  });

  it("doesn't count one too short, one-sided or between far levels", () => {
    expect(duelCredited({ ...fair, ms: DUEL.creditMs - 1 })).toBe(false);
    expect(duelCredited({ ...fair, loserDamage: 39 })).toBe(false);
    expect(
      duelCredited({ ...fair, loserLevel: 30 - DUEL.creditLevelGap - 1 }),
    ).toBe(false);
  });
});
