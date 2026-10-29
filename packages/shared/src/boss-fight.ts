/**
 * The cave raid's rules: lobby, roster lock, health scaling, the
 * boss's walk, enrage, minions and the music it hates. Pure data and maths,
 * shared by the Town server (which runs the fight), the desktop (which
 * shows it) and, where noted, mirrored in SQL (00122_boss_revamp.sql).
 *
 * The shape of the fight, and the industry practice behind each number, is
 * in specs/boss-fight.md.
 */
import type { BossRewardPool } from "./types.js";

// ---------------------------------------------------------------------------
// Lobby, lock, and who's in

/** The cave opens this long before the event's start; the fight locks at
 * the start. Mirrored by open_boss_json. */
export const BOSS_LOBBY_MS = 15 * 60_000;

/** Disconnected for longer than this mid-fight: out for good (no reward).
 * Long enough for a crash and a restart, short enough that nobody is
 * carried to the loot. */
export const BOSS_OUT_GRACE_MS = 2 * 60_000;

/** Where a raid is: waiting in the lobby, fighting, or done. */
export type RaidStage = "lobby" | "fight" | "over";

// ---------------------------------------------------------------------------
// Health scales with the roster

/** The boss's health per herzie, unless the event's config sets its own
 * `hpPerPlayer`. Calibrated on the fights before the raid (five herzies
 * dealt ~60k each in four minutes, nine ~44k in four and a half: about
 * 250-340 damage a second each) so a roster fells it in six to eight
 * minutes. In raid-sim, bots that never miss and never stop take about
 * five and a half. Mirrored by lock_boss_fight. */
export const BOSS_HP_PER_PLAYER = 130_000;
/** Health grows a little slower than the roster (WoW's flex raids): a big
 * group has a slight edge, and nobody is turned away to keep it easy. */
export const BOSS_HP_EXPONENT = 0.9;

/** The boss's health for a roster of `n`. Mirrored by lock_boss_fight. */
export function bossMaxHp(
  n: number,
  perPlayer: number = BOSS_HP_PER_PLAYER,
): number {
  const players = Math.max(1, Math.floor(n));
  return Math.round(perPlayer * players ** BOSS_HP_EXPONENT);
}

/** A whole number near `expected` without breakpoints: 2.4 is 2 or 3, 3 with
 * a 40% chance. So one more herzie never tips a mechanic over a cliff. */
export function weightedRound(expected: number, rand: () => number): number {
  const lo = Math.floor(expected);
  return lo + (rand() < expected - lo ? 1 : 0);
}

// ---------------------------------------------------------------------------
// The boss's walk

/** The boss roams inside this circle: most of the room, but never right
 * up against the wall (where it could be pinned and cheesed) and never
 * onto the spawn at (0, 10). */
export const BOSS_WANDER = {
  x: 0,
  z: -2,
  radius: 7,
  /** Metres a second: still slower than a walking herzie (4.5), so it can
   * be kited, but quick enough that it does get around. */
  speed: 2.4,
  /** Radians a second it can turn. */
  turn: 3.5,
  /** It stops this far (between surfaces) from whoever it's after: inside
   * a melee blow's reach (1.6), so a tank can stand and trade. */
  keep: 0.6,
} as const;

/** How far along a ray from `from` (inside the circle) heading `yaw` the
 * boss can go before leaving its wander circle. */
export function wanderReach(
  from: { x: number; z: number },
  yaw: number,
): number {
  const dx = Math.sin(yaw);
  const dz = Math.cos(yaw);
  const ox = from.x - BOSS_WANDER.x;
  const oz = from.z - BOSS_WANDER.z;
  // |o + d t| = R, solved for the positive t.
  const b = ox * dx + oz * dz;
  const c = ox * ox + oz * oz - BOSS_WANDER.radius ** 2;
  const disc = b * b - c;
  if (disc <= 0) return 0;
  return Math.max(0, -b + Math.sqrt(disc));
}

/** `p` pulled back inside the wander circle. */
export function clampToWander(p: { x: number; z: number }): {
  x: number;
  z: number;
} {
  const dx = p.x - BOSS_WANDER.x;
  const dz = p.z - BOSS_WANDER.z;
  const d = Math.hypot(dx, dz);
  if (d <= BOSS_WANDER.radius) return { x: p.x, z: p.z };
  const k = BOSS_WANDER.radius / d;
  return { x: BOSS_WANDER.x + dx * k, z: BOSS_WANDER.z + dz * k };
}

// ---------------------------------------------------------------------------
// Enrage: a fight has a length

export const BOSS_ENRAGE = {
  /** From the lock: the boss starts to quicken... */
  softMs: 10 * 60_000,
  /** ...a little more every this long... */
  stepMs: 30_000,
  /** ...by this much (attack pace and damage, compounding)... */
  step: 0.1,
  /** ...and at this point it ends the fight: an unavoidable pulse. */
  hardMs: 15 * 60_000,
  /** How often the pulse comes once it starts, and its windup. */
  pulseEveryMs: 6_000,
  pulseWindupMs: 4_000,
} as const;

/** How much harder the boss hits and how much faster it attacks, `sinceLockMs`
 * into the fight: 1 until the soft enrage, then up a step every `stepMs`. */
export function enrageFactor(sinceLockMs: number): number {
  if (sinceLockMs < BOSS_ENRAGE.softMs) return 1;
  const steps =
    1 + Math.floor((sinceLockMs - BOSS_ENRAGE.softMs) / BOSS_ENRAGE.stepMs);
  return (1 + BOSS_ENRAGE.step) ** steps;
}

// ---------------------------------------------------------------------------
// Minions: Tower Thornlings, at low health

/** At these shares of its health, the boss calls a pack. */
export const MINION_THRESHOLDS = [0.5, 0.25] as const;

/** Where the boss changes gear: phase 2 below the first share of its
 * health, phase 3 below the second. The HUD marks them on its bar. */
export const BOSS_PHASE_AT = [0.66, 0.33] as const;
/** The pack: about one per two herzies, two at least, eight at most. */
export function minionPackSize(roster: number, rand: () => number): number {
  return Math.min(8, Math.max(2, weightedRound(roster / 2, rand)));
}
/** How strong they are, unless the event names a floor: as the Tower floor
 * at this share of the raid's average level. A little below the raid, so a
 * pack is pressure to deal with, not a second boss (at the raid's own
 * level, sim parties that killed the boss easily were wiped by its adds). */
export const MINION_LEVEL_SHARE = 0.75;
/** Their floor when there's no one to take a level from. */
export const MINION_FLOOR = 10;

/** The floor a raid of average level `level` meets its minions at. */
export function minionFloorFor(level: number): number {
  return Math.max(1, Math.round(level * MINION_LEVEL_SHARE));
}

// ---------------------------------------------------------------------------
// The music it hates

/** The boss hates music, any music: playing some is a class's bonus, once
 * it has played this long, and kept this long after it stops (so a gap
 * between tracks doesn't flicker it). */
export const IN_TUNE = {
  settleMs: 3_000,
  lingerMs: 8_000,
  /** Percussionist: this much less damage (with Def and a Cymbrella, under
   * the 75% clamp). */
  def: 0.15,
  /** Bard: heals (Drones, Resurrect) this many times stronger. */
  heal: 1.3,
  /** Record Slinger: hits this many times harder. */
  damage: 1.25,
} as const;

/** What an in-tune herzie of class `cls` gets: the kind of bonus and its
 * value, or null for a classless herzie (or an unknown class). */
export function inTuneBonus(
  cls: string | null | undefined,
): { kind: "def" | "heal" | "damage"; value: number } | null {
  if (cls === "percussionist") return { kind: "def", value: IN_TUNE.def };
  if (cls === "bard") return { kind: "heal", value: IN_TUNE.heal };
  if (cls === "record_slinger")
    return { kind: "damage", value: IN_TUNE.damage };
  return null;
}

/** A tune message's `on` (whether music is playing), or null if it isn't
 * one. */
export function parseTune(on: unknown): boolean | null {
  return typeof on === "boolean" ? on : null;
}

/** The fewest ms between two tune messages the room accepts. */
export const TUNE_MIN_INTERVAL_MS = 1_500;

/** The most items one reward pool may hold. */
export const MAX_REWARD_POOL_ITEMS = 20;

/**
 * Checks and tidies a boss fight's `rewardPools` as typed into the admin:
 * known items only (`isItem`), no repeats within a pool, a known mode, and a
 * chance in (0, 100] for "chance" pools. Empty pools are dropped. Returns
 * the cleaned pools, or what's wrong with them.
 */
export function parseBossRewardPools(
  value: unknown,
  isItem: (itemId: string) => boolean,
): { pools: BossRewardPool[] } | { error: string } {
  if (value === undefined || value === null) return { pools: [] };
  if (!Array.isArray(value)) return { error: "Reward pools must be a list" };
  const pools: BossRewardPool[] = [];
  for (const [i, raw] of value.entries()) {
    const label = `Reward pool ${i + 1}`;
    if (!raw || typeof raw !== "object")
      return { error: `${label} is invalid` };
    const { itemIds, mode, chance } = raw as Record<string, unknown>;
    if (!Array.isArray(itemIds) || itemIds.some((id) => typeof id !== "string"))
      return { error: `${label}: items must be item ids` };
    const ids = [...new Set(itemIds as string[])].filter((id) => id !== "");
    if (ids.length === 0) continue;
    if (ids.length > MAX_REWARD_POOL_ITEMS)
      return { error: `${label}: at most ${MAX_REWARD_POOL_ITEMS} items` };
    const unknown = ids.find((id) => !isItem(id));
    if (unknown) return { error: `${label}: unknown item "${unknown}"` };
    if (mode === "all") {
      pools.push({ itemIds: ids, mode });
    } else if (mode === "chance") {
      if (typeof chance !== "number" || !(chance > 0 && chance <= 100))
        return { error: `${label}: chance must be above 0 and at most 100` };
      pools.push({ itemIds: ids, mode, chance });
    } else {
      return { error: `${label}: mode must be "all" or "chance"` };
    }
  }
  return { pools };
}

/** Each item's own chance in a pool, in percent: 100 for "all", else the
 * pool's chance split evenly between its items. */
export function rewardPoolItemChance(pool: BossRewardPool): number {
  if (pool.mode === "all") return 100;
  return (pool.chance ?? 0) / Math.max(1, pool.itemIds.length);
}
