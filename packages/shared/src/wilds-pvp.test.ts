import { describe, expect, it } from "vitest";
import { DUEL, DUEL_MAPS, duelDamage, duelMaxHp } from "./duel.js";
import { levelStats, pointsForLevel } from "./stats.js";
import { TOWN_MAPS } from "./town-net.js";
import { inWildsSafeCamp, WILDS_SAFE_CAMP } from "./wilds.js";
import {
  WILDS_PVP,
  wildsCanHurt,
  wildsDamage,
  wildsInCombat,
  wildsMaxHp,
  wildsRegenStep,
  wildsSonicCap,
} from "./wilds-pvp.js";

const camp = { x: WILDS_SAFE_CAMP.x, z: WILDS_SAFE_CAMP.z };
/** From the camp toward the island's middle. */
const inward = -Math.sign(WILDS_SAFE_CAMP.x);
const out = { x: WILDS_SAFE_CAMP.x + inward * (WILDS_SAFE_CAMP.r + 5), z: 0 };

describe("the Wilds' free-for-all", () => {
  it("is fought outside the camp only, both ends of a blow", () => {
    const outToo = { x: out.x + inward * 3, z: 2 };
    expect(wildsCanHurt(out, outToo)).toBe(true);
    // From the camp, or into it: nothing.
    expect(wildsCanHurt(camp, out)).toBe(false);
    expect(wildsCanHurt(out, camp)).toBe(false);
    // The edge is the camp's.
    const edge = { x: WILDS_SAFE_CAMP.x + inward * WILDS_SAFE_CAMP.r, z: 0.5 };
    expect(inWildsSafeCamp(edge.x, edge.z)).toBe(true);
    expect(wildsCanHurt(out, edge)).toBe(false);
  });

  it("puts the spawn (where you get up) in the camp", () => {
    const { spawn } = TOWN_MAPS.wilds;
    expect(inWildsSafeCamp(spawn.x, spawn.z)).toBe(true);
  });

  it("has no duels: everyone there already fights", () => {
    expect(DUEL_MAPS.has("wilds")).toBe(false);
    // And the camp is too small for a ring to stay in.
    expect(DUEL.ringRadius).toBeGreaterThan(WILDS_SAFE_CAMP.r - 2);
  });

  it("gives health by level, as a duel does", () => {
    expect(wildsMaxHp(20)).toBe(duelMaxHp(20));
    expect(wildsMaxHp(40)).toBeGreaterThan(wildsMaxHp(20));
  });

  it("holds Sonic Power to the victim's level + 10", () => {
    // A level-10 victim: what a level-20 herzie could have, every point
    // in Sonic Power, with the best gear.
    expect(wildsSonicCap(10)).toBe(
      levelStats(20).sonicPower + pointsForLevel(20) + WILDS_PVP.gearSonicPower,
    );
    // It grows with the victim's level: a fair fight is never capped.
    expect(wildsSonicCap(30)).toBeGreaterThan(wildsSonicCap(10));
    // Junk levels count as level 1.
    expect(wildsSonicCap(0)).toBe(wildsSonicCap(1));
  });

  it("hits as a duel's regulation, never more than 30% of health", () => {
    const hit = { amount: 200, mult: 1, def: 10, maxHp: 400 };
    expect(wildsDamage(hit)).toBe(duelDamage({ ...hit, fightMs: 0 }));
    const huge = wildsDamage({ ...hit, amount: 1e6 });
    expect(huge).toBe(Math.round(DUEL.maxHitFraction * 400));
    expect(wildsDamage({ ...hit, amount: 0 })).toBe(1);
  });

  it("keeps you in combat for the window after your last blow", () => {
    expect(wildsInCombat(1_000, 1_000 + WILDS_PVP.combatMs - 1)).toBe(true);
    expect(wildsInCombat(1_000, 1_000 + WILDS_PVP.combatMs)).toBe(false);
    expect(wildsInCombat(Number.NEGATIVE_INFINITY, 0)).toBe(false);
  });

  it("heals back to full in about 25 s out of combat", () => {
    const max = wildsMaxHp(20);
    const steps = Math.ceil(max / wildsRegenStep(max));
    const s = (steps * WILDS_PVP.regenEveryMs) / 1000;
    expect(s).toBeGreaterThan(20);
    expect(s).toBeLessThanOrEqual(26);
    expect(wildsRegenStep(1)).toBe(1);
  });
});
