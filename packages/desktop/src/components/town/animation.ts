import { type CreaturePose, IDLE_LOOP_FRAMES } from "@herzies/shared";
import { MathUtils } from "three";

/** The idle loop's frame rate: Herzie3D plays it at 50ms a frame. */
export const IDLE_FPS = 20;
/** Top walking speed, in world units a second. */
export const WALK_SPEED = 4.5;
/** Ground covered by one walk cycle (a left and a right step). The cycle
 * advances by distance travelled, so the feet keep pace with the ground at
 * any speed — including when a wall cuts the speed to nothing. */
export const STRIDE = 2.4;
/** How fast the blend between standing and walking follows the speed. */
const WALK_BLEND_RATE = 12;

/** Turn steps the rotation is drawn at (one per 10°), and camera pitch
 * steps (one per 5°, up to 45°). */
const TURN_STEPS = 36;
const PITCH_STEP = (5 * Math.PI) / 180;
const PITCH_STEPS = 9;
/** Walk-cycle frames: 16 a cycle, 8 a step. */
const WALK_STEPS = 16;

export type AnimationState = {
  /** Seconds into the idle loop. */
  idleTime: number;
  /** 0..1 through the walk cycle. */
  walkPhase: number;
  /** 0 standing to 1 walking. */
  walkWeight: number;
};

export function newAnimationState(seed = 0): AnimationState {
  // Visitors start at different points of their breath, so a crowd doesn't
  // breathe in unison.
  return { idleTime: seed % 6, walkPhase: 0, walkWeight: 0 };
}

/** Advances the clocks by `dt` seconds at ground `speed`. */
export function stepAnimation(
  s: AnimationState,
  dt: number,
  speed: number,
): void {
  s.idleTime = (s.idleTime + dt) % (IDLE_LOOP_FRAMES / IDLE_FPS);
  s.walkPhase = (s.walkPhase + (speed * dt) / STRIDE) % 1;
  // Fully walking from half speed up: a slow shuffle still reads as walking.
  const target = MathUtils.clamp(speed / (WALK_SPEED * 0.5), 0, 1);
  s.walkWeight = MathUtils.damp(s.walkWeight, target, WALK_BLEND_RATE, dt);
  if (s.walkWeight < 1e-3) s.walkWeight = 0;
}

/**
 * Snaps a continuous pose onto the frames worth caching, and names it.
 * Everything a frame depends on is in the key, and nothing else: a walking
 * herzie's frame doesn't depend on its idle clock (unless it has a pet
 * floating beside it, which keeps breathing), and a standing one's doesn't
 * depend on the walk phase.
 */
export function quantizePose(p: {
  yAngle: number;
  pitch: number;
  anim: AnimationState;
  breathesWhileWalking: boolean;
}): { key: string; pose: CreaturePose } {
  const turn =
    (((Math.round(p.yAngle / ((Math.PI * 2) / TURN_STEPS)) % TURN_STEPS) +
      TURN_STEPS) %
      TURN_STEPS) |
    0;
  const pitch = MathUtils.clamp(
    Math.round(p.pitch / PITCH_STEP),
    0,
    PITCH_STEPS,
  );
  const w = p.anim.walkWeight < 0.15 ? 0 : p.anim.walkWeight > 0.85 ? 1 : 0.5;
  const idle =
    w === 1 && !p.breathesWhileWalking
      ? 0
      : Math.floor(p.anim.idleTime * IDLE_FPS) % IDLE_LOOP_FRAMES;
  const phase =
    w === 0 ? 0 : Math.round(p.anim.walkPhase * WALK_STEPS) % WALK_STEPS;
  return {
    key: `${turn}|${pitch}|${idle}|${phase}|${w}`,
    pose: {
      yAngle: (turn / TURN_STEPS) * Math.PI * 2,
      pitch: pitch * PITCH_STEP,
      idleFrame: idle,
      walkPhase: phase / WALK_STEPS,
      walkWeight: w,
    },
  };
}

/** The signed shortest turn from `from` to `to`, in (-π, π]. */
export function angleDelta(from: number, to: number): number {
  const d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) return d - Math.PI * 2;
  if (d <= -Math.PI) return d + Math.PI * 2;
  return d;
}

/** Eases a heading toward `target` the short way round, frame-rate
 * independently (like MathUtils.damp), turning no faster than `maxRate`
 * radians a second. */
export function turnToward(
  heading: number,
  target: number,
  rate: number,
  maxRate: number,
  dt: number,
): number {
  const d = angleDelta(heading, target);
  const eased = d * (1 - Math.exp(-rate * dt));
  const capped = MathUtils.clamp(eased, -maxRate * dt, maxRate * dt);
  return heading + capped;
}
