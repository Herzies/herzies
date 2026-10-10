/**
 * Secondary motion for things that hang off a herzie (the gold chain, the
 * pearls) while it's spun.
 *
 * Not a per-link simulation — at ASCII resolution nobody could tell. The
 * whole hanging part is one angle on a damped spring tied to the body's
 * rotation, which is enough for the three things a real chain visibly does:
 *
 *  - lag: start spinning and it trails behind the body;
 *  - follow-through: stop and it keeps swinging on, then eases back to rest;
 *  - flare: spin fast and it's thrown outward, lifting off the chest.
 *
 * Like a real chain, it's the spin *changing* that swings it: damping acts on
 * the chain's motion relative to the body, so a steady spin doesn't hold it
 * back. Only a little air drag does (−drag·ω/stiffness) — a slight trail,
 * not the chain being towed behind through syrup.
 *
 * Angles are in the renderer's yAngle units (radians). Pure: HerzieView owns a
 * DangleSim and steps it each animation frame; the renderer only ever sees
 * the resulting DangleState.
 */

export interface DangleConfig {
  /** Spring pull back toward the body. Higher = quicker, tighter wobble. */
  stiffness: number;
  /** How fast the wobble dies out (acts on the swing, not the spin). */
  damping: number;
  /** Air drag: how far a steady spin trails. Keep it small. */
  drag: number;
  /** Largest swing shown, in radians. Past it the swing eases off (tanh). */
  maxSwing: number;
  /** Spin speed (rad/s) at which the flare is at full lift. */
  flareSpeed: number;
}

// Tuned by feel in the sandbox. Overdamped (damping ratio ~1.3): the chain
// swings with the spin and eases back to rest without wobbling — a heavy
// chain, not a spring.
export const DEFAULT_DANGLE_CONFIG: DangleConfig = {
  stiffness: 105,
  damping: 26.7,
  drag: 1.5,
  maxSwing: 0.7,
  flareSpeed: 20,
};

/** What the renderer applies to dangling spheres. */
export interface DangleState {
  /** Chain angle minus body angle, radians. Negative = trailing a spin toward +yAngle. */
  swing: number;
  /** 0 (hanging) to 1 (fully thrown out). */
  flare: number;
}

export interface DangleSim {
  angle: number;
  velocity: number;
  flare: number;
  /** The body angle at the end of the last step. */
  body: number;
  /** The body's spin speed, smoothed over a few frames. */
  bodyVelocity: number;
}

export function createDangleSim(bodyAngle: number): DangleSim {
  return {
    angle: bodyAngle,
    velocity: 0,
    flare: 0,
    body: bodyAngle,
    bodyVelocity: 0,
  };
}

// Fixed substep so a dropped frame can't make the spring blow up.
const SUBSTEP = 1 / 240;
// Time constant (s) the body's spin speed is smoothed over. Mouse events don't
// land evenly on frames — one frame gets two moves, the next none — and the
// damping term would turn that unevenness straight into flicker.
const BODY_VELOCITY_SMOOTHING = 0.06;
// How quickly the flare follows the spin, per second.
const FLARE_RATE = 14;

function flareTarget(speed: number, config: DangleConfig): number {
  return Math.min(1, (speed / config.flareSpeed) ** 2);
}

export function stepDangle(
  sim: DangleSim,
  bodyAngle: number,
  dt: number,
  config: DangleConfig = DEFAULT_DANGLE_CONFIG,
): void {
  const span = Math.min(dt, 0.1);
  const from = sim.body;
  if (span > 0) {
    const raw = (bodyAngle - from) / span;
    sim.bodyVelocity +=
      (raw - sim.bodyVelocity) *
      (1 - Math.exp(-span / BODY_VELOCITY_SMOOTHING));
  }
  const bodyVelocity = sim.bodyVelocity;
  let done = 0;
  while (done < span) {
    const h = Math.min(SUBSTEP, span - done);
    done += h;
    // The body moved steadily across the frame, not all at once at its start:
    // holding it at the new angle would add half a frame of phantom lag.
    const body =
      span > 0 ? from + (bodyAngle - from) * (done / span) : bodyAngle;
    const accel =
      -config.stiffness * (sim.angle - body) -
      config.damping * (sim.velocity - bodyVelocity) -
      config.drag * sim.velocity;
    // Semi-implicit Euler: stable for a spring at this step size.
    sim.velocity += accel * h;
    sim.angle += sim.velocity * h;
  }
  sim.body = bodyAngle;
  const target = flareTarget(Math.abs(sim.velocity), config);
  sim.flare += (target - sim.flare) * Math.min(1, dt * FLARE_RATE);
}

export function dangleState(
  sim: DangleSim,
  bodyAngle: number,
  config: DangleConfig = DEFAULT_DANGLE_CONFIG,
): DangleState {
  const raw = sim.angle - bodyAngle;
  return {
    swing: config.maxSwing * Math.tanh(raw / config.maxSwing),
    flare: sim.flare,
  };
}

/** At rest on a still body — the caller can stop stepping and drop the sim. */
export function isDangleSettled(sim: DangleSim, bodyAngle: number): boolean {
  return (
    // Well under a cell of movement: past this nobody can see it, and every
    // frame the sim keeps running is a live render instead of a cached one.
    Math.abs(sim.angle - bodyAngle) < 0.005 &&
    Math.abs(sim.velocity - sim.bodyVelocity) < 0.02 &&
    Math.abs(sim.bodyVelocity) < 0.02 &&
    sim.flare < 0.01
  );
}

/** The pose a steady spin at `speed` rad/s settles into: a constant trail
 * and flare. Used to bake the chain into the precomputed rotation loop. */
export function steadyDangle(
  speed: number,
  config: DangleConfig = DEFAULT_DANGLE_CONFIG,
): DangleState {
  const raw = (-config.drag * speed) / config.stiffness;
  return {
    swing: config.maxSwing * Math.tanh(raw / config.maxSwing),
    flare: flareTarget(Math.abs(speed), config),
  };
}

/** A steady pose plus a live one, e.g. the rotation loop's trail plus a
 * drag's wobble on top of it. */
export function combineDangle(
  base: DangleState | undefined,
  live: DangleState | null | undefined,
): DangleState | undefined {
  if (!base) return live ?? undefined;
  if (!live) return base;
  return {
    swing: base.swing + live.swing,
    flare: Math.max(base.flare, live.flare),
  };
}
