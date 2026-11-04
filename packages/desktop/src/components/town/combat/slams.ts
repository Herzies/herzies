import { RIMSHOT, SKILL_DEFS } from "@herzies/shared";
import type { Vec3 } from "./waves";

/**
 * Rimshots as this client shows them, anyone's: winding up (a ring on the
 * ground at its reach, filling in; the charge at the stick), then the slam
 * (the shockwave, cracks, dust). The server judges the hits; this is the
 * show, keyed to each herzie's own animation: it lands when the herzie's
 * stick does (`land`, on its `released`). Times are performance.now() ms.
 */
export type Slam = {
  by: number;
  /** Where its Percussionist stands (the reach's centre). */
  x: number;
  z: number;
  castAt: number;
  /** When it should land (the wind-up's end). */
  dueAt: number;
  /** When it did, and where the stick struck (null until it lands). */
  landedAt: number | null;
  hit: Vec3;
  /** Where the stick's head is now, for the charge gathering on it. */
  tip: ((out: Vec3) => Vec3) | null;
};

/** How long a slam's aftermath shows (the cracks fade last). */
export const SLAM_AFTER_MS = 1_400;

export const slams: Slam[] = [];

/** `by` started a Rimshot at (x, z), `now`. */
export function beginSlam(
  by: number,
  x: number,
  z: number,
  now: number,
  tip: Slam["tip"] = null,
): Slam {
  cancelSlam(by);
  const s: Slam = {
    by,
    x,
    z,
    castAt: now,
    dueAt: now + (SKILL_DEFS.rimshot.castMs ?? 0),
    landedAt: null,
    hit: [x, 0, z],
    tip,
  };
  slams.push(s);
  prune(now);
  return s;
}

/** `by`'s Rimshot winding up, if any. */
export function pendingSlam(by: number): Slam | undefined {
  return slams.find((s) => s.by === by && s.landedAt === null);
}

/** `by`'s stick struck the ground at `hit`: the slam lands. */
export function landSlam(
  by: number,
  hit: Readonly<Vec3>,
  now: number,
): Slam | null {
  const s = pendingSlam(by);
  if (!s) return null;
  s.landedAt = now;
  s.hit = [hit[0], hit[1], hit[2]];
  return s;
}

/** `by`'s wind-up was cut short (knocked out): it never lands. Whether
 * there was one. */
export function cancelSlam(by: number): boolean {
  const i = slams.findIndex((s) => s.by === by && s.landedAt === null);
  if (i < 0) return false;
  slams.splice(i, 1);
  return true;
}

/** Whether (x, z) is within a slam's reach of `s` (for practice hits). */
export function inSlamReach(
  s: { x: number; z: number },
  x: number,
  z: number,
  radius: number,
): boolean {
  return Math.hypot(x - s.x, z - s.z) <= RIMSHOT.radius + radius;
}

export function prune(now: number): void {
  for (let i = slams.length - 1; i >= 0; i--) {
    const s = slams[i];
    const gone =
      s.landedAt !== null
        ? now > s.landedAt + SLAM_AFTER_MS
        : now > s.dueAt + 1_500;
    if (gone) slams.splice(i, 1);
  }
}

export function clearSlams(): void {
  slams.length = 0;
}
