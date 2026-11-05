import type { AttackStyle, MeleeBlow } from "@herzies/shared/classes";
import { useSyncExternalStore } from "react";

/**
 * Combat on the training grounds: whether you're in it, and what the frame
 * loop needs to share about it outside React — your aim, your casts, and
 * how hard the last hit shook the camera.
 */
export const combat = {
  /** In combat mode: the mouse aims, a click casts. */
  on: false,
  /** How the mouse is held for aiming (see mouseLook): null when it isn't. */
  look: null as "locked" | "grabbed" | "free" | null,
  /** The cast button (left mouse, or F) is held: cast again as soon as the
   * last one's done. */
  fireHeld: false,
  /** When a cast was last asked for that hasn't started yet (performance.now
   * ms): a press during a cast is kept this long, so mashing never drops a
   * shot. */
  queuedAt: Number.NEGATIVE_INFINITY,
  /** Casts made, for the town server to count (see TOWN_CAST_MASK). */
  casts: 0,
  /** How shaken the camera is, 0–1; it shakes by the square of this and
   * settles on its own (see CameraRig). */
  trauma: 0,
  /** A heavy blow's jolt (a Rimshot's slam): the camera dips by `kick` (world
   * units) at `kickAt` (performance.now() ms) and springs back. Directional,
   * on top of the trauma's shake. */
  kick: 0,
  kickAt: Number.NEGATIVE_INFINITY,
  /** Held where it stands until then (performance.now() ms): a Rimshot's
   * wind-up roots its Percussionist. */
  rootedUntil: Number.NEGATIVE_INFINITY,
  /** The crosshair's spread, 0 tight to 1 wide: kicks on each cast. */
  spread: 0,
  /** Whether the crosshair is over a dummy. */
  onTarget: false,
  /** A melee blow struck now would land on something: a dummy, or the
   * boss (see meleeReaches). The crosshair says so. */
  inReach: false,
  /** Mouse-look not yet turned into camera turn, in pixels (CameraRig takes
   * it each frame). */
  lookX: 0,
  lookY: 0,
  /** Waves and dummies are held near-still until then (performance.now
   * ms): the beat of hit-stop on a crit. */
  slowUntil: 0,
  /** The last hit, for the crosshair's hit marker: when, and whether a
   * crit. */
  hitAt: Number.NEGATIVE_INFINITY,
  hitCrit: false,
  /** Your best damage per second on any dummy, this session. */
  bestDps: 0,
  /** Your basic attack: a wave, a disc thrown from each hand, or a blow up
   * close (classes.ts basicAttack: a class's, with its instrument). */
  attack: "melee" as AttackStyle,
  /** Which blow a melee attack is: a stick, a punch or a body slam. */
  blow: "bump" as MeleeBlow,
  /** Throwing discs: which are in hand (the crosshair shows them), and
   * when each was last caught (performance.now ms). */
  discs: {
    in: { "held-l": true, "held-r": true },
    caughtAt: {
      "held-l": Number.NEGATIVE_INFINITY,
      "held-r": Number.NEGATIVE_INFINITY,
    },
  },
};

/** How long a press waits for the cast before it, in ms. */
export const CAST_BUFFER_MS = 180;

const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** Into or out of combat mode. */
export function setCombat(on: boolean, look: typeof combat.look = null): void {
  if (combat.on === on && combat.look === look) return;
  combat.on = on;
  combat.look = on ? look : null;
  combat.fireHeld = false;
  combat.queuedAt = Number.NEGATIVE_INFINITY;
  emit();
}

/** Whether combat mode is on, re-rendering when it changes. */
export function useCombat(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => combat.on,
  );
}

/** Shake the camera: `amount` of trauma on top of what's there (capped). */
export function shake(amount: number): void {
  // Asked for less motion: no shaking (the sound and the flash still say
  // what happened).
  if (reducedMotion()) return;
  combat.trauma = Math.min(1, combat.trauma + amount);
}

/** A heavy blow's jolt: the camera dips `amount` (world units) and springs
 * back (see combat.kick). Not under reduced motion. */
export function kick(amount: number): void {
  if (reducedMotion()) return;
  combat.kick = amount;
  combat.kickAt = performance.now();
}

/** How far the camera is dipped by a kick at `now`: down at once, back up
 * past level a touch, settled in about a third of a second. */
export function kickOffset(now: number): number {
  const t = (now - combat.kickAt) / 1000;
  if (t < 0 || t > 0.5) return 0;
  return -combat.kick * Math.exp(-t / 0.09) * Math.cos(t * 2 * Math.PI * 3.2);
}

let motionQuery: MediaQueryList | null | undefined;
/** Whether the system asks for reduced motion (looked up once, then
 * followed as it changes). */
export function reducedMotion(): boolean {
  if (motionQuery === undefined)
    motionQuery =
      typeof matchMedia === "function"
        ? matchMedia("(prefers-reduced-motion: reduce)")
        : null;
  return !!motionQuery?.matches;
}
