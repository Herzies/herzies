/**
 * Secondary motion for things that hang off a herzie (the gold chain, the
 * pearls) while it's spun.
 *
 * Not a per-link simulation — at ASCII resolution nobody could tell. The
 * whole hanging part is one angle on a damped spring tied to the body's
 * rotation, which is enough for the three things a real chain visibly does:
 *
 *  - lag: start spinning and it trails behind the body;
 *  - overshoot: stop and it swings past, wobbling a few times before settling;
 *  - flare: spin fast and it's thrown outward, lifting off the chest.
 *
 * The spring's damping acts on the chain's own speed, not its speed relative
 * to the body, which is what makes a steady spin hold a steady trailing lag
 * (−damping·ω/stiffness) instead of snapping back to rest.
 *
 * Angles are in the renderer's yAngle units (radians). Pure: Herzie3D owns a
 * DangleSim and steps it each animation frame; the renderer only ever sees
 * the resulting DangleState.
 */

export interface DangleConfig {
  /** Spring pull back toward the body. Higher = quicker, tighter wobble. */
  stiffness: number;
  /** How fast the wobble dies out, and how far a steady spin trails. */
  damping: number;
  /** Largest swing shown, in radians. Past it the swing eases off (tanh). */
  maxSwing: number;
  /** Spin speed (rad/s) at which the flare is at full lift. */
  flareSpeed: number;
}

// ~0.8s period, damping ratio ~0.26: about three visible wobbles after a stop.
export const DEFAULT_DANGLE_CONFIG: DangleConfig = {
  stiffness: 60,
  damping: 4,
  maxSwing: 0.7,
  flareSpeed: 12,
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
}

export function createDangleSim(bodyAngle: number): DangleSim {
  return { angle: bodyAngle, velocity: 0, flare: 0, body: bodyAngle };
}

// Fixed substep so a dropped frame can't make the spring blow up.
const SUBSTEP = 1 / 240;
// How quickly the flare follows the spin, per second.
const FLARE_RATE = 8;

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
  let done = 0;
  while (done < span) {
    const h = Math.min(SUBSTEP, span - done);
    done += h;
    // The body moved steadily across the frame, not all at once at its start:
    // holding it at the new angle would add half a frame of phantom lag.
    const body =
      span > 0 ? from + (bodyAngle - from) * (done / span) : bodyAngle;
    const accel =
      -config.stiffness * (sim.angle - body) - config.damping * sim.velocity;
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
    Math.abs(sim.angle - bodyAngle) < 1e-3 &&
    Math.abs(sim.velocity) < 1e-3 &&
    sim.flare < 1e-3
  );
}

/** The pose a steady spin at `speed` rad/s settles into: a constant trail
 * and flare. Used to bake the chain into the precomputed rotation loop. */
export function steadyDangle(
  speed: number,
  config: DangleConfig = DEFAULT_DANGLE_CONFIG,
): DangleState {
  const raw = (-config.damping * speed) / config.stiffness;
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
