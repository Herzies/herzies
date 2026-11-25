import { CYMBAL_TRAP } from "@herzies/shared";
import { CAST_RELEASE_SECONDS } from "@herzies/shared/gl";
import type { Vec3 } from "./waves";

/**
 * Cymbal Traps as this client shows them, anyone's: the cymbal thrown
 * along its Percussionist's aim, and, once the server says it caught
 * something (`trap`), spinning round it until its hold ends. The server
 * judges the hit and the hold; this is the show (vfx/CymbalTrapVFX), and
 * the hand the cymbal left (empty until it fades). In practice the cymbal
 * is aimed at its dummy as it's thrown. Times are performance.now() ms.
 */

/** What a cymbal caught: a herzie (entity id), a mob (its id) or, in
 * practice, a dummy (its key). */
export type TrapTarget =
  | { kind: "herzie"; id: number }
  | { kind: "mob"; id: number }
  | { kind: "dummy"; key: string };

export type Trap = {
  by: number;
  /** Where its Percussionist stood, and which way it threw. */
  x: number;
  z: number;
  yaw: number;
  at: number;
  /** Where its Percussionist's off hand is now, for the cymbal to leave
   * it; null: from over where it stood. */
  hand: ((out: Vec3) => Vec3) | null;
  /** What it caught (null: still flying, or missed), when it got there,
   * and when its hold ends. */
  target: TrapTarget | null;
  caughtAt: number;
  until: number;
  /** The show's own: where the cymbal's drawn, whether it's left the hand
   * yet, and where it was as it began to circle (it eases in from
   * there). */
  pos: Vec3;
  out: boolean;
  orbitFrom: Vec3 | null;
};

/** How long a cymbal takes to fade: at the end of a miss's flight, or of
 * its hold. */
export const TRAP_FADE_MS = 300;
/** When the cymbal leaves the hand, after the throw begins: a throw's
 * release. */
export const TRAP_RELEASE_MS = CAST_RELEASE_SECONDS * 1000;
/** How long a missed cymbal flies: out to its reach. */
export const TRAP_MISS_MS = (CYMBAL_TRAP.range / CYMBAL_TRAP.speed) * 1000;

export const traps: Trap[] = [];

/** `by` threw its cymbal from (x, z) along `yaw`, `now`. One cymbal each:
 * its cooldown outlasts any flight and hold. */
export function throwCymbal(
  by: number,
  x: number,
  z: number,
  yaw: number,
  now: number,
  hand: Trap["hand"] = null,
): Trap {
  cancelCymbal(by);
  const t: Trap = {
    by,
    x,
    z,
    yaw,
    at: now,
    hand,
    target: null,
    caughtAt: Number.POSITIVE_INFINITY,
    until: Number.NEGATIVE_INFINITY,
    pos: [x, 0, z],
    out: false,
    orbitFrom: null,
  };
  traps.push(t);
  pruneTraps(now);
  return t;
}

/** `by`'s cymbal caught `target` at `at` (in practice: will, as it's
 * thrown), holding it until `until`. Its throw unseen (thrown from out of
 * sight, or before you came), it starts on its target. */
export function catchCymbal(
  by: number,
  target: TrapTarget,
  until: number,
  at: number,
): Trap {
  const t =
    traps.find((s) => s.by === by && s.target === null) ??
    throwCymbal(by, 0, 0, 0, at);
  t.target = target;
  t.caughtAt = at;
  t.until = until;
  return t;
}

/** `by`'s throw never happened (refused): its cymbal's back in hand. */
export function cancelCymbal(by: number): void {
  const i = traps.findIndex((s) => s.by === by);
  if (i >= 0) traps.splice(i, 1);
}

/** When trap `t` is gone from sight: faded after its hold, or after a
 * miss's flight. */
export function trapEnds(t: Trap): number {
  return t.target
    ? t.until + TRAP_FADE_MS
    : t.at + TRAP_RELEASE_MS + TRAP_MISS_MS + TRAP_FADE_MS;
}

/** `by`'s cymbal, thrown and not yet faded, if any. */
export function trapBy(by: number): Trap | undefined {
  return traps.find((t) => t.by === by);
}

/** Whether `by`'s cymbal is out of its hand at `now`: from the throw's
 * release until it fades (its held one is hidden then). */
export function cymbalOut(by: number, now: number): boolean {
  const t = trapBy(by);
  return !!t && t.out && now < trapEnds(t);
}

export function pruneTraps(now: number): void {
  for (let i = traps.length - 1; i >= 0; i--)
    if (now > trapEnds(traps[i])) traps.splice(i, 1);
}

export function clearTraps(): void {
  traps.length = 0;
}
