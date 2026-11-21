/**
 * The Wilds' free-for-all: everyone outside the safe camp (wilds.ts) may
 * hurt everyone else outside it, judged by the Town server (town-server
 * `wilds.ts`) the way it judges a duel. These are the rules both ends read.
 *
 * Dying costs only time. PvP health lives in the room alone: it is never
 * written to the database and never knocks a herzie out there. Taken down,
 * a herzie lies where it fell for a few seconds, then gets up in the camp
 * with full health and a moment's protection.
 *
 * Fights are levelled the way duels are (duel.ts): health from the level
 * alone, Def at a share, every basic attack a wave's worth. That keeps
 * every class pairing between 15 and 30 s to bring down (the duel matrix
 * test), a fair pace for a fight anyone may walk into. Gear and stat
 * points still count, class for class. On top of that, a big herzie's
 * Sonic Power is held to what one ten levels above its victim could have
 * (no farming the newcomers), and no hit takes more than 30% of anyone's
 * health (DUEL.maxHitFraction).
 *
 * Kept free of React and the DOM: bundled into the Worker and the app.
 */
import { DUEL, duelDamage, duelMaxHp } from "./duel.js";
import { levelStats, pointsForLevel } from "./stats.js";
import { inWildsSafeCamp } from "./wilds.js";

export const WILDS_PVP = {
  /** Taken down: up again in the camp this long after. */
  respawnMs: 6_000,
  /** Just arrived or got up: hits on you don't count for this long, or
   * until you attack (a cast or an attacking skill outside the camp). A
   * reconnect within `keepMs` doesn't count as arriving. */
  shieldMs: 5_000,
  /** In combat this long after you last took or dealt PvP damage: leaving
   * the room then counts as being taken down (the last to hit you gets
   * the line), and no sky ship will take you aboard. */
  combatMs: 10_000,
  /** A herzie that leaves finds its PvP health, and what's left of its
   * protection, as it left them if it's back within this (a reconnect, or
   * a window hidden a while, neither heals nor protects again). */
  keepMs: 30_000,
  /**
   * Health comes back on its own, out of combat: from `combatMs` after the
   * last blow either way (the same window as the boarding lock, so a fight
   * that's only paused never heals mid-way), `regenShare` of max health a
   * second. From nearly nothing that's 25 s: longer than getting up in
   * camp (6 s and the walk back), so walking away hurt has a cost, short
   * enough that nobody sits about waiting.
   */
  regenShare: 0.04,
  /** Health comes back in steps this far apart (each one goes out to the
   * room). */
  regenEveryMs: 1_000,
  /** An attacker's Sonic Power is held to what a herzie this many levels
   * above its victim could have. */
  levelBand: 10,
  /** The Sonic Power that band allows from gear, on top of what levels
   * and stat points give: room for a set of the best gear (a piece adds 3
   * to 10). Gear isn't level-gated, so only levels and points make the
   * gap; this keeps gear out of it. */
  gearSonicPower: 40,
  /** A Rimshot's stun on a herzie, as a share of its stun on a mob (with
   * its diminishing returns), as in a duel. */
  stunScale: DUEL.stunScale,
  /** Who hears a herzie was taken down: the two of them and anyone within
   * this of where it fell (world units). */
  feedRange: 40,
} as const;

/** A herzie's PvP health: its level's (duelMaxHp), as in a duel. */
export function wildsMaxHp(level: number): number {
  return duelMaxHp(level);
}

/** The most Sonic Power an attacker hits a herzie of `victimLevel` with:
 * what a herzie WILDS_PVP.levelBand levels above it could have, with every
 * stat point in Sonic Power and the best gear. */
export function wildsSonicCap(victimLevel: number): number {
  const level = Math.max(1, Math.floor(victimLevel)) + WILDS_PVP.levelBand;
  return (
    levelStats(level).sonicPower +
    pointsForLevel(level) +
    WILDS_PVP.gearSonicPower
  );
}

/** What one hit in the Wilds takes off its victim: a duel's hit in
 * regulation (duelDamage), capped at DUEL.maxHitFraction of its health. */
export function wildsDamage(hit: {
  amount: number;
  mult: number;
  def: number;
  reductions?: readonly number[];
  maxHp: number;
}): number {
  return duelDamage({ ...hit, fightMs: 0 });
}

/** Whether a blow from a herzie at `from` may hurt one at `to`: neither
 * is in the safe camp. (Being down or protected is the judge's to say.) */
export function wildsCanHurt(
  from: { x: number; z: number },
  to: { x: number; z: number },
): boolean {
  return !inWildsSafeCamp(from.x, from.z) && !inWildsSafeCamp(to.x, to.z);
}

/** Whether a herzie that last took or dealt PvP damage at `lastBlow` is
 * still in combat at `now`. */
export function wildsInCombat(lastBlow: number, now: number): boolean {
  return now - lastBlow < WILDS_PVP.combatMs;
}

/** One regeneration step's health, out of `maxHp`. */
export function wildsRegenStep(maxHp: number): number {
  return Math.max(
    1,
    Math.ceil((maxHp * WILDS_PVP.regenShare * WILDS_PVP.regenEveryMs) / 1000),
  );
}
