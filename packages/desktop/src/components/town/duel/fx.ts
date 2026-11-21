import type { HerzieModel } from "@herzies/shared/gl";
import { reducedMotion } from "../combat/state";

/**
 * How a duel's blows look on the two herzies in it: a flash on the one hit,
 * both held still a beat (hit-stop), a lean away from the blow, the winning
 * blow slowed, and the loser on its knees. Per fighter and presentation
 * only: the room (and everyone else in it) runs on at full speed.
 */

/** Timings, ms; angles, radians. */
export const FX = {
  flashMs: 120,
  /** The loser's flash on the winning blow, longer and brighter. */
  finishFlashMs: 260,
  /** Hit-stop on an ordinary hit, a crit, and the finishing blow. */
  stopMs: 70,
  critStopMs: 90,
  finishStopMs: 150,
  /** After the finishing blow's stop, both fighters' animation runs at
   * `slowScale` for `slowMs`. */
  slowMs: 400,
  slowScale: 0.35,
  /** The lean away from a blow, and how long it takes to come back. */
  lean: 0.18,
  leanMs: 200,
  /** The loser kneels this long, tipped forward this far and lowered. */
  kneelMs: 2_400,
  kneel: 0.42,
  kneelDrop: 0.16,
} as const;

type Fighter = {
  flashAt: number;
  flashMs: number;
  stopUntil: number;
  slowUntil: number;
  /** The lean: when, and which way (a unit direction on the ground). */
  leanAt: number;
  leanX: number;
  leanZ: number;
  kneelUntil: number;
  /** How far into the kneel it's drawn, 0–1 (eased). */
  kneeling: number;
  /** Whether the pose was set last frame (so it's put back once). */
  posed: boolean;
};

const fighters = new Map<number, Fighter>();

function fighter(id: number): Fighter {
  let f = fighters.get(id);
  if (!f) {
    f = {
      flashAt: Number.NEGATIVE_INFINITY,
      flashMs: FX.flashMs,
      stopUntil: 0,
      slowUntil: 0,
      leanAt: Number.NEGATIVE_INFINITY,
      leanX: 0,
      leanZ: 0,
      kneelUntil: 0,
      kneeling: 0,
      posed: false,
    };
    fighters.set(id, f);
  }
  return f;
}

/** Herzie `id` was hit: it flashes. */
export function flashFighter(
  id: number,
  now: number,
  ms: number = FX.flashMs,
): void {
  const f = fighter(id);
  f.flashAt = now;
  f.flashMs = ms;
}

/** Herzie `id` holds still for `ms` (not under reduced motion). */
export function stopFighter(id: number, ms: number, now: number): void {
  if (reducedMotion()) return;
  const f = fighter(id);
  f.stopUntil = Math.max(f.stopUntil, now + ms);
}

/** The winning blow: both held, then slowed (not under reduced motion). */
export function finishFighters(ids: readonly number[], now: number): void {
  if (reducedMotion()) return;
  for (const id of ids) {
    const f = fighter(id);
    f.stopUntil = now + FX.finishStopMs;
    f.slowUntil = now + FX.finishStopMs + FX.slowMs;
  }
}

/** Herzie `id` leans away from a blow that came along (dx, dz). */
export function leanFighter(
  id: number,
  dx: number,
  dz: number,
  now: number,
): void {
  if (reducedMotion()) return;
  const n = Math.hypot(dx, dz);
  if (n < 1e-3) return;
  const f = fighter(id);
  f.leanAt = now;
  f.leanX = dx / n;
  f.leanZ = dz / n;
}

/** Herzie `id` lost: down on its knees a while. */
export function kneelFighter(id: number, now: number): void {
  fighter(id).kneelUntil = now + FX.kneelMs;
}

/** Whether herzie `id` is on its knees (the notes circle it). */
export function kneeling(id: number, now: number): boolean {
  const f = fighters.get(id);
  return !!f && (now < f.kneelUntil || f.kneeling > 0.05);
}

/** How fast herzie `id`'s animation runs now: 0 held, slowed after a
 * finishing blow, else 1. */
export function fighterPace(id: number | null, now: number): number {
  if (id === null) return 1;
  const f = fighters.get(id);
  if (!f) return 1;
  if (now < f.stopUntil) return 0;
  if (now < f.slowUntil) return FX.slowScale;
  return 1;
}

/**
 * Draws herzie `id`'s duel pose on `herzie`: the flash, the lean and the
 * kneel. Call each frame after its update (and after applyDowned, whose
 * tip it leaves alone while it isn't kneeling or leaning).
 */
export function poseFighter(
  herzie: HerzieModel,
  id: number | null,
  now: number,
  dt: number,
): void {
  const f = id === null ? undefined : fighters.get(id);
  if (!f) return;
  const since = now - f.flashAt;
  const flash =
    since < f.flashMs
      ? (1 - since / f.flashMs) * (reducedMotion() ? 0.6 : 1)
      : 0;
  herzie.setFlash(1, 1, 1, flash);
  const target = now < f.kneelUntil ? 1 : 0;
  f.kneeling += (target - f.kneeling) * Math.min(1, dt * 7);
  if (Math.abs(f.kneeling - target) < 0.002) f.kneeling = target;
  const lean = Math.max(0, 1 - (now - f.leanAt) / FX.leanMs) * FX.lean;
  if (f.kneeling === 0 && lean === 0) {
    if (f.posed) {
      herzie.root.rotation.x = 0;
      herzie.root.rotation.z = 0;
      f.posed = false;
    }
    if (flash === 0 && now > f.slowUntil && now > f.kneelUntil)
      fighters.delete(id as number);
    return;
  }
  // Tipped toward (tx, tz) on the ground: forward (its heading) to kneel,
  // away from the blow to lean. A turn about x tips the top toward +z;
  // one about z, toward −x.
  const k = f.kneeling * FX.kneel;
  const tx = Math.sin(herzie.heading) * k + f.leanX * lean;
  const tz = Math.cos(herzie.heading) * k + f.leanZ * lean;
  herzie.root.rotation.x = tz;
  herzie.root.rotation.z = -tx;
  herzie.root.position.y -= f.kneeling * FX.kneelDrop * herzie.height;
  f.posed = true;
}

/** Everything forgotten (another island). */
export function forgetFighters(): void {
  fighters.clear();
}
