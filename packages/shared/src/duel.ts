/**
 * Duels: 1v1 fights between two herzies, anywhere in a peaceful room (Home,
 * the training grounds, the Wilds). Walk up to a herzie, challenge it; if it
 * accepts, a ring drops around the two of you and the Town server judges the
 * fight (town-server `duel.ts`), the way it judges a boss fight.
 *
 * Nothing is lost: duel HP lives in the room for the duel only. It starts
 * full, is never written to the database, and a defeated herzie just kneels
 * (its stored HP is untouched). Wins count towards titles (titles.ts).
 *
 * A duel is levelled between the classes, which PvE isn't (there a tank is
 * meant to outlast everyone): duel health comes from the level alone
 * (duelMaxHp), Def counts for less (DUEL.defScale), and every basic attack
 * hits as a wave does (duelAttackShare). Stats still matter, class for
 * class; what a class is for in a raid doesn't decide the duel.
 *
 * Kept free of React and the DOM: bundled into the Worker and the app.
 */
import { mitigatedDamage, STRIKE_DAMAGE } from "./combat.js";
import type { TownMapId } from "./town-net.js";
import { maxHp } from "./vitals.js";

export const DUEL = {
  /** How close (world units, centre to centre) you must stand to challenge. */
  challengeRange: 8,
  /** Slack the server allows on the ranges, for interpolation. */
  rangeSlack: 1.5,
  /** The pair must still be this close when the challenge is accepted. */
  acceptRange: 20,
  /** How long a challenge waits for an answer. */
  askTtlMs: 20_000,
  /** Least time between two challenges from one herzie. */
  askGapMs: 5_000,
  /** Before challenging the same herzie again after a decline or no answer;
   * a second decline within `declineWindowMs` makes it `declinePenaltyMs`. */
  declineCooldownMs: 30_000,
  declineWindowMs: 10 * 60_000,
  declinePenaltyMs: 5 * 60_000,

  /** The ring: centred between the two, clamped to fit the map. */
  ringRadius: 14,
  /** Within this of the centre, nothing warns you. */
  ringWarn: 11.5,
  /** Each duelist is put on a mark this far from the centre, facing the
   * other, for the countdown. */
  markRadius: 6,

  /** From accept to the fight: a VS card (`introMs`, skipped on a rematch),
   * then 3-2-1 at `countMs` each. Movement and casts are held until then. */
  introMs: 600,
  countMs: 800,
  /** Regulation; then sudden death until `hardCapMs`, when the higher share
   * of health wins (a draw if level). */
  regulationMs: 90_000,
  hardCapMs: 150_000,
  /** In sudden death: damage ×`suddenDamage` and healing ×`suddenHeal`,
   * compounding every `suddenStepMs`. */
  suddenStepMs: 10_000,
  suddenDamage: 1.25,
  suddenHeal: 0.5,

  /** Outside the ring this long and you've yielded. Paused while stunned. */
  outOfBoundsMs: 3_000,
  /** A dropped connection may come back this long and pick the duel up. */
  reconnectMs: 10_000,
  /** After the end, either may ask for a rematch; it starts once both have,
   * within this. */
  rematchMs: 12_000,

  /** No single hit takes more than this share of the victim's max HP. */
  maxHitFraction: 0.3,
  /** A hit on a herzie as a share of the same hit on the boss: a boss has
   * tens of thousands of HP, a herzie a few hundred. Sized with defScale
   * so every pairing of the classes, landing every basic cast at the cast
   * budget's pace, takes 15 to 30 s at level 20 and at level 40, neither
   * side more than a third quicker than the other (town-server
   * duel.test.ts). */
  damageScale: 0.0405,
  /** How much of its Def a herzie fights a duel with. A Percussionist's
   * Def (Stamina, and its class's 1.5×) is the tank's in a raid; in full
   * it would more than double how long a duel with one takes. Enough is
   * kept that Def still takes a share off. */
  defScale: 0.15,
  /** A disc's share of a wave in a duel. A Slinger puts every point into
   * Sonic Power and crits; a Bard, half of them into Euphony for its
   * heals. Hit for hit at a disc's full share, the Slinger would bring a
   * Bard down over a third sooner than the Bard it. */
  discShare: 0.85,
  /** A Rimshot's stun on a herzie, as a share of its stun on a mob. */
  stunScale: 0.5,

  /** A win counts towards titles only if the duel lasted this long, the
   * loser dealt at least `creditDamage` of the winner's max HP, and their
   * levels are within `creditLevelGap`. */
  creditMs: 15_000,
  creditDamage: 0.1,
  creditLevelGap: 10,
} as const;

/** The maps a duel may be fought on: the peaceful ones. The boss cave and
 * the Tower have fights of their own. */
export const DUEL_MAPS: ReadonlySet<TownMapId> = new Set([
  "home",
  "arena",
  "wilds",
]);

/** When the fight starts, in ms after the accept. */
export function duelCountdownMs(intro: boolean): number {
  return (intro ? DUEL.introMs : 0) + 3 * DUEL.countMs;
}

/** Sudden death's multipliers `ms` after the duel's fight began (1 and 1
 * in regulation). */
export function suddenDeath(ms: number): { damage: number; heal: number } {
  if (ms < DUEL.regulationMs) return { damage: 1, heal: 1 };
  const steps = 1 + Math.floor((ms - DUEL.regulationMs) / DUEL.suddenStepMs);
  return {
    damage: DUEL.suddenDamage ** steps,
    heal: DUEL.suddenHeal ** steps,
  };
}

/** Where the ring goes for two herzies at `a` and `b`: their midpoint,
 * pulled in so the whole ring stays on a map of walkable `mapRadius`
 * (centred on the origin). Null when the map is too small for one. */
export function duelRing(
  a: { x: number; z: number },
  b: { x: number; z: number },
  mapRadius: number,
): { x: number; z: number } | null {
  const room = mapRadius - DUEL.ringRadius - 1;
  if (room < 0) return null;
  let x = (a.x + b.x) / 2;
  let z = (a.z + b.z) / 2;
  const d = Math.hypot(x, z);
  if (d > room) {
    x *= room / d;
    z *= room / d;
  }
  return { x, z };
}

/** The two start marks: `markRadius` either side of the centre, along the
 * line from `a` to `b` (so neither has to cross the other). */
export function duelMarks(
  centre: { x: number; z: number },
  a: { x: number; z: number },
  b: { x: number; z: number },
): { a: { x: number; z: number }; b: { x: number; z: number } } {
  let dx = b.x - a.x;
  let dz = b.z - a.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) {
    dx = 1;
    dz = 0;
  } else {
    dx /= d;
    dz /= d;
  }
  const r = DUEL.markRadius;
  return {
    a: { x: centre.x - dx * r, z: centre.z - dz * r },
    b: { x: centre.x + dx * r, z: centre.z + dz * r },
  };
}

/** Whether a finished duel's win counts towards titles. */
export function duelCredited(r: {
  /** How long the fight ran (from "FIGHT!"). */
  ms: number;
  /** Damage the loser dealt. */
  loserDamage: number;
  winnerMaxHp: number;
  winnerLevel: number;
  loserLevel: number;
}): boolean {
  return (
    r.ms >= DUEL.creditMs &&
    r.loserDamage >= DUEL.creditDamage * r.winnerMaxHp &&
    Math.abs(r.winnerLevel - r.loserLevel) <= DUEL.creditLevelGap
  );
}

/** Whether `p` stands inside a ring centred on `centre` (its edge counts
 * as in). */
export function inDuelRing(
  centre: { x: number; z: number },
  p: { x: number; z: number },
): boolean {
  return Math.hypot(p.x - centre.x, p.z - centre.z) <= DUEL.ringRadius;
}

/** A herzie's health in a duel: its level's, before Stamina. Stamina is a
 * tank's toughness for a raid; in a duel it would decide who wins (a
 * Percussionist puts most of its points there). Def still counts, scaled
 * (DUEL.defScale). */
export function duelMaxHp(level: number): number {
  return maxHp(level);
}

/** A basic attack's share of a wave in a duel: a wave, a Percussionist's
 * stick alike, a punch or a bump that much weaker than a stick (`melee`:
 * its share in a fight, meleeDamage), a disc DUEL.discShare. A boss fight
 * pays a disc extra for the wait while it comes back and a stick for
 * standing in the boss's reach; in the ring two discs outpace the cast
 * budget anyway, and closing in on a herzie is what a melee duel is. */
export function duelAttackShare(
  style: "wave" | "disc" | "melee",
  melee: number,
): number {
  if (style === "melee") return melee / STRIKE_DAMAGE;
  return style === "disc" ? DUEL.discShare : 1;
}

/** What one duel hit takes off its victim: the cast's roll (`amount`,
 * hitDamage's, spread and crit in) times its attack's share of a wave
 * (`mult`: duelAttackShare's, or a skill's), scaled for a herzie, less the
 * victim's Def (classDef'd, then DUEL.defScale) and buffs' `reductions`,
 * raised in sudden death (`fightMs` into the fight), never more than
 * DUEL.maxHitFraction of its max HP, and at least 1. */
export function duelDamage(hit: {
  amount: number;
  mult: number;
  def: number;
  reductions?: readonly number[];
  fightMs: number;
  maxHp: number;
}): number {
  const raw = hit.amount * hit.mult * DUEL.damageScale;
  const kept =
    mitigatedDamage(raw, hit.def * DUEL.defScale, hit.reductions) *
    suddenDeath(hit.fightMs).damage;
  const cap = DUEL.maxHitFraction * hit.maxHp;
  return Math.max(1, Math.round(Math.min(cap, kept)));
}
