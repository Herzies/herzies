/**
 * What a sonic wave does. Kept apart from the item catalog so the Town
 * server (a Worker) can roll a cast's damage without bundling it; `items.ts`
 * re-exports these, so the rest of the app imports them from the same place
 * as before.
 */

/** The stats a hit reads. */
export type HitStats = {
  sonicPower: number;
  critChance: number;
  critDamage: number;
};

/** What one sonic wave deals before sonic power: the training dummies'
 * numbers. */
export const HIT_BASE = 100;
/** How far a hit's damage wanders either way of its base, as a fraction. */
export const HIT_SPREAD = 0.1;

/** One hit of a herzie's sonic wave: the base, raised by sonic power the
 * way boss damage is (10 sonic power is +10%), wandering ±HIT_SPREAD; and,
 * at crit chance percent, a critical hit — crit damage percent on top.
 * `rand` is two uniform [0, 1) draws (spread, then crit), so a test can
 * pin them. */
export function hitDamage(
  stats: HitStats,
  rand: () => number = Math.random,
): { amount: number; crit: boolean } {
  const spread = 1 + (rand() * 2 - 1) * HIT_SPREAD;
  const crit = rand() < stats.critChance / 100;
  const amount =
    HIT_BASE *
    (1 + stats.sonicPower / 100) *
    spread *
    (crit ? 1 + stats.critDamage / 100 : 1);
  return { amount: Math.round(amount), crit };
}

// ---------------------------------------------------------------------------
// Waves in flight, as the Town server and the desktop both need them

/** How fast a wave travels, world units a second. */
export const WAVE_SPEED = 26;
/** How far it goes before it's spent, if it hits nothing. */
export const WAVE_RANGE = 42;
/** Aim assist: a target this close to the line of aim (radians, seen from
 * the hand) draws the wave in. */
export const WAVE_ASSIST_ANGLE = (3 * Math.PI) / 180;
/** How wide a wave is to what it hits, on top of the target's own radius. */
export const WAVE_HIT_RADIUS = 0.2;
/** Height of the hand a wave leaves from, above the herzie's feet. */
export const WAVE_HAND_HEIGHT = 1.2;

export type Vec3 = [number, number, number];

/** The unit direction of a cast, from the yaw and pitch a client sends. */
export function aimDirection(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return [c * Math.sin(yaw), Math.sin(pitch), c * Math.cos(yaw)];
}

/** The yaw and pitch of a unit direction (the inverse of aimDirection). */
export function aimAngles(dir: Readonly<Vec3>): { yaw: number; pitch: number } {
  return {
    yaw: Math.atan2(dir[0], dir[2]),
    pitch: Math.asin(Math.max(-1, Math.min(1, dir[1]))),
  };
}

/**
 * How far along `dir` from `from` a wave reaches `target` (a sphere), if
 * the cast would find it: dead on, or within the aim assist (widened up
 * close, so a target right in front is always in reach). Null if it misses
 * or is out of range. The client draws waves toward the same targets with
 * the same rule, so what a player sees land is what the server counts.
 */
export function waveReaches(
  from: Readonly<Vec3>,
  dir: Readonly<Vec3>,
  target: { x: number; y: number; z: number; radius: number },
): number | null {
  const tx = target.x - from[0];
  const ty = target.y - from[1];
  const tz = target.z - from[2];
  const dist = Math.hypot(tx, ty, tz);
  if (dist < 1e-6 || dist > WAVE_RANGE) return null;
  const cos = (tx * dir[0] + ty * dir[1] + tz * dir[2]) / dist;
  const angle =
    Math.acos(Math.min(1, Math.max(-1, cos))) -
    Math.atan((target.radius + WAVE_HIT_RADIUS) / dist);
  return angle <= WAVE_ASSIST_ANGLE ? dist : null;
}

/** The boss in its cave: where it stands and how big it is, for the Town
 * server's hit test and the desktop's drawing and collider alike. */
export const BOSS_STAND = {
  x: 0,
  z: -4,
  /** Its body's radius on the ground, and the height of its middle. */
  radius: 2.2,
  chest: 2.4,
} as const;
