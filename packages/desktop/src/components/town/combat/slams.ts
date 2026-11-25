import { RIMSHOT, SILENCIO, SKILL_DEFS } from "@herzies/shared";
import type { Vec3 } from "./waves";

/** The skills with a wind-up that roots their caster and lands where it
 * stands: a Percussionist's Rimshot, a Bard's Silencio. */
export type SlamSkill = "rimshot" | "silencio";

/** How far each reaches from its caster's centre. */
export const SLAM_RADIUS: Record<SlamSkill, number> = {
  rimshot: RIMSHOT.radius,
  silencio: SILENCIO.radius,
};

/**
 * Rimshots and Silencios as this client shows them, anyone's: winding up
 * (a Rimshot's ring on the ground at its reach, filling in, the charge at
 * the stick; a Silencio's lute drawn in), then the landing (the slam's
 * shockwave, cracks and dust; the wave of silence). The server judges the
 * hits; this is the show, keyed to each herzie's own animation: it lands
 * when the herzie's stick strikes, or its lute sweeps out (`land`, on its
 * `released`). Times are performance.now() ms.
 */
export type Slam = {
  by: number;
  skill: SlamSkill;
  /** Where its caster stands (the reach's centre). */
  x: number;
  z: number;
  castAt: number;
  /** When it should land (the wind-up's end). */
  dueAt: number;
  /** When it did, and where the stick struck or the lute swept out (null
   * until it lands). */
  landedAt: number | null;
  hit: Vec3;
  /** Where the stick's head (the lute) is now, for the charge gathering
   * on it. */
  tip: ((out: Vec3) => Vec3) | null;
};

/** How long a landing's aftermath shows (a slam's cracks fade last). */
export const SLAM_AFTER_MS = 1_400;

export const slams: Slam[] = [];

/** `by` started winding up `skill` at (x, z), `now`. */
export function beginSlam(
  by: number,
  skill: SlamSkill,
  x: number,
  z: number,
  now: number,
  tip: Slam["tip"] = null,
): Slam {
  cancelSlam(by);
  const s: Slam = {
    by,
    skill,
    x,
    z,
    castAt: now,
    dueAt: now + (SKILL_DEFS[skill].castMs ?? 0),
    landedAt: null,
    hit: [x, 0, z],
    tip,
  };
  slams.push(s);
  prune(now);
  return s;
}

/** `by`'s wind-up under way, if any. */
export function pendingSlam(by: number): Slam | undefined {
  return slams.find((s) => s.by === by && s.landedAt === null);
}

/** `by`'s stick struck the ground (its lute swept out) at `hit`: it
 * lands. */
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

/** `by`'s wind-up was cut short (knocked out, refused): it never lands.
 * Whether there was one. */
export function cancelSlam(by: number): boolean {
  const i = slams.findIndex((s) => s.by === by && s.landedAt === null);
  if (i < 0) return false;
  slams.splice(i, 1);
  return true;
}

/** Whether (x, z) is within the reach of `s`'s skill from its centre, for
 * a body of `radius` (for practice hits). */
export function inSlamReach(
  s: { skill: SlamSkill; x: number; z: number },
  x: number,
  z: number,
  radius: number,
): boolean {
  return Math.hypot(x - s.x, z - s.z) <= SLAM_RADIUS[s.skill] + radius;
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
