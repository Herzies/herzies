import { MathUtils } from "three";
import { turnToward, WALK_SPEED } from "./animation";
import type { TownInput } from "./input";

/** Speeding up and slowing down (per second, MathUtils.damp rates):
 * quick to start, quicker to stop, so it feels responsive but not
 * weightless. */
const ACCELERATION = 10;
const DECELERATION = 14;
/** Turning to face where it walks: eased, but never faster than this. */
const TURN_RATE = 14;
const MAX_TURN_SPEED = 12;

export type Mover = { vx: number; vz: number; heading: number };

/**
 * One fixed step of the player's intent, before collisions: where it wants
 * to go and which way it faces. Pure, so the controls can be tested
 * without a scene.
 *
 * - WASD / arrows walk relative to the camera (`azimuth`, camera-controls'
 *   convention: 0 puts the camera on the +z side, looking toward -z).
 * - Holding the right mouse button turns the herzie with the camera, so
 *   A/D strafe; holding both buttons walks forward.
 * - Otherwise the herzie turns to face where it walks.
 */
export function stepMover(
  m: Mover,
  input: TownInput,
  azimuth: number,
  dt: number,
): void {
  // Camera-relative directions on the ground: forward is away from it.
  const fx = -Math.sin(azimuth);
  const fz = -Math.cos(azimuth);
  const rx = Math.cos(azimuth);
  const rz = -Math.sin(azimuth);
  const both = input.mouseLeft && input.mouseRight;
  const ahead = (input.forward || both ? 1 : 0) - (input.back ? 1 : 0);
  const side = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let mx = fx * ahead + rx * side;
  let mz = fz * ahead + rz * side;
  const len = Math.hypot(mx, mz);
  if (len > 0) {
    mx /= len;
    mz /= len;
  }

  const rate = len > 0 ? ACCELERATION : DECELERATION;
  m.vx = MathUtils.damp(m.vx, mx * WALK_SPEED, rate, dt);
  m.vz = MathUtils.damp(m.vz, mz * WALK_SPEED, rate, dt);

  if (input.mouseRight) {
    m.heading = turnToward(
      m.heading,
      Math.atan2(fx, fz),
      TURN_RATE * 2,
      MAX_TURN_SPEED * 2,
      dt,
    );
  } else if (len > 0) {
    m.heading = turnToward(
      m.heading,
      Math.atan2(mx, mz),
      TURN_RATE,
      MAX_TURN_SPEED,
      dt,
    );
  }
}

/**
 * Which camera azimuth walking is relative to. Normally the camera's own,
 * so W is always "away from the camera". But left-dragging is for looking
 * around: while the left button alone is held the walk keeps its
 * direction, so you can look at something without veering toward it. On
 * release, walking follows the camera again.
 */
export function walkAzimuth(
  previous: number | null,
  cameraAzimuth: number,
  input: TownInput,
): number {
  const lookingAround = input.mouseLeft && !input.mouseRight;
  return lookingAround && previous !== null ? previous : cameraAzimuth;
}
