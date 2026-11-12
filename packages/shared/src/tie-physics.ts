/**
 * A necktie's blade: a short chain of points hung from the knot and lying
 * on the chest, simulated so it moves a little with the herzie.
 *
 * The way game ties, scarves and hair cords are done, boiled down (Unreal's
 * Chaos cloth / physics-asset chains, Unity's spring bones, Verlet "rope"
 * and PBD chains; the same recipe as thread-physics.ts):
 *
 *  - Verlet integration at a fixed substep, so a long frame can't blow it
 *    up, with a few distance-constraint passes for a thread that never
 *    stretches (and, being cloth, never bunches up either).
 *  - Simulated in the herzie's own frame, feeling its moving as forces: it
 *    speeds up and the tie lags, it stops and the tie swings on, it turns
 *    and the tie trails, its walk bob jolts the knot. Scaled by a
 *    response and clamped: a teleport or a dropped frame never flings it.
 *  - A restoring spring toward the pose it lies in (bending stiffness and
 *    the shirt holding it), strong: the tie is a quiet secondary motion, a
 *    nudge that settles within a beat, not a pendulum.
 *  - Collision with the torso (a sphere), so it rides on the chest
 *    rather than through it, and a cap on how far any point strays from its
 *    rest, per point, so even a violent move stays a believable swing.
 *
 * Creature space throughout (y down, front −z), in the torso's frame (the
 * renderer moves the whole tie with the torso's own pose offset). Pure.
 */

type V3 = [number, number, number];

/** How a tie hangs: built with the herzie (see the renderer's
 * buildNecktieSpheres). */
export interface TieRig {
  /** Where the blade is tied, under the knot, at rest. */
  root: V3;
  /** The blade's points, from the knot down, where each lies at rest. */
  rest: V3[];
  /** The length of each segment: from the root for the first, from the
   * point before for the rest. */
  lengths: number[];
  /** The torso it lies on, and how far each point's centre keeps from its
   * middle. */
  center: V3;
  clear: number[];
}

/** What moves the herzie this step (see thread-physics's ThreadInput). */
export interface TieInput {
  /** How far the torso is moved from rest by the pose: its walk bob. */
  offset: V3;
  /** Its acceleration, creature units/s², creature space. */
  accel: V3;
  /** How fast it turns about its vertical (creature y), rad/s. */
  turnRate: number;
  /** How fast it's going, creature units/s, creature space. */
  velocity?: V3;
}

export interface TieSim {
  pos: V3[];
  prev: V3[];
  turnRate: number;
  offset: V3;
  bobVelocity: V3;
}

/** How the tie feels. Deliberately gentle. */
export interface TieConfig {
  /** Pull of gravity, creature units/s² (+y is down). */
  gravity: number;
  /** How quickly a swing dies away, per second. */
  damping: number;
  /** How hard the air of its going blows the tie back, per unit speed. */
  drag: number;
  /** How much of the herzie's moving the tie feels, 0 to 1. */
  response: number;
  /** Pull back toward where it lies, per second² per unit of distance. */
  stiffness: number;
  /** How far a point may stray from its rest, as a fraction of the blade's
   * length from the knot to it. */
  reach: number;
}

export const DEFAULT_TIE_CONFIG: TieConfig = {
  // Nothing extra: the rest pose already is the tie hanging (on the chest to
  // the belly's widest point, then straight down), and the spring is what
  // brings it back to it, so gravity on top would only sag it.
  gravity: 0,
  damping: 7,
  drag: 3,
  response: 0.5,
  stiffness: 220,
  reach: 0.55,
};

const MAX_ACCEL = 25;
const MAX_TURN = 8;
const TURN_EASE = 0.12;
const MAX_SPEED = 12;
const SUBSTEP = 1 / 240;
const MAX_SUBSTEPS = 24;
const PASSES = 3;

export function createTieSim(rig: TieRig): TieSim {
  return {
    pos: rig.rest.map((p) => [...p] as V3),
    prev: rig.rest.map((p) => [...p] as V3),
    turnRate: 0,
    offset: [0, 0, 0],
    bobVelocity: [0, 0, 0],
  };
}

/** Advances it `dt` seconds. */
export function stepTieSim(
  sim: TieSim,
  rig: TieRig,
  dt: number,
  input: TieInput,
  config: TieConfig = DEFAULT_TIE_CONFIG,
): void {
  if (dt <= 0) return;
  const steps = Math.min(MAX_SUBSTEPS, Math.ceil(dt / SUBSTEP));
  const h = dt / steps;
  // The torso's bob is felt as a jolt (the renderer carries the whole tie
  // with the torso's offset, so only its acceleration reaches the points).
  const bobVelocity = scale(sub(input.offset, sim.offset), 1 / dt);
  const bobAccel = scale(sub(bobVelocity, sim.bobVelocity), 1 / dt);
  sim.offset = [...input.offset];
  sim.bobVelocity = bobVelocity;
  const accel = scale(
    clampLength(add(input.accel, bobAccel), MAX_ACCEL),
    config.response,
  );
  const wind = scale(
    clampLength(input.velocity ?? [0, 0, 0], MAX_SPEED),
    -config.drag,
  );
  const turn =
    Math.max(-MAX_TURN, Math.min(MAX_TURN, input.turnRate)) * config.response;
  const keep = Math.exp(-config.damping * h);
  // How far each point may stray: more the further down the blade.
  let run = 0;
  const reach = rig.lengths.map((l) => {
    run += l;
    return run * config.reach;
  });
  for (let s = 0; s < steps; s++) {
    const w =
      sim.turnRate + (turn - sim.turnRate) * (1 - Math.exp(-h / TURN_EASE));
    const spinUp = (w - sim.turnRate) / h;
    sim.pos.forEach((p, i) => {
      const v = scale(sub(p, sim.prev[i]), 1 / h);
      const r = sub(p, rig.center);
      const sweep = config.drag * w;
      const toRest = sub(rig.rest[i], p);
      const a: V3 = [
        wind[0] +
          config.stiffness * toRest[0] -
          sweep * r[2] -
          accel[0] +
          w * w * r[0] -
          spinUp * r[2] -
          2 * w * v[2],
        wind[1] + config.gravity + config.stiffness * toRest[1] - accel[1],
        wind[2] +
          config.stiffness * toRest[2] +
          sweep * r[0] -
          accel[2] +
          w * w * r[2] +
          spinUp * r[0] +
          2 * w * v[0],
      ];
      const next = add(
        p,
        add(scale(sub(p, sim.prev[i]), keep), scale(a, h * h)),
      );
      sim.prev[i] = p;
      sim.pos[i] = next;
    });
    sim.turnRate = w;
    for (let pass = 0; pass < PASSES; pass++) constrain(sim, rig, reach);
  }
}

/** Nothing on the tie is moving to speak of. */
export function isTieSettled(sim: TieSim): boolean {
  return sim.pos.every((p, i) => Math.hypot(...sub(p, sim.prev[i])) < 1e-5);
}

function constrain(sim: TieSim, rig: TieRig, reach: number[]) {
  for (let i = 0; i < sim.pos.length; i++) {
    // Not too far from where it lies.
    const away = sub(sim.pos[i], rig.rest[i]);
    const gone = Math.hypot(...away);
    if (gone > reach[i]) {
      sim.pos[i] = add(rig.rest[i], scale(away, reach[i] / gone));
    }
    // Riding on the chest, not through it.
    const d = sub(sim.pos[i], rig.center);
    const at = Math.hypot(...d);
    if (at < rig.clear[i] && at > 1e-9) {
      sim.pos[i] = add(rig.center, scale(d, rig.clear[i] / at));
    }
  }
  // A thread's length, from the knot down: cloth neither stretches nor
  // bunches. The point above gives too, a little, but the knot never does.
  for (let i = 0; i < sim.pos.length; i++) {
    const tied = i === 0 ? rig.root : sim.pos[i - 1];
    const d = sub(sim.pos[i], tied);
    const length = Math.hypot(...d);
    if (length < 1e-9) continue;
    const fix = scale(d, (length - rig.lengths[i]) / length);
    if (i === 0) sim.pos[0] = sub(sim.pos[0], fix);
    else {
      sim.pos[i] = sub(sim.pos[i], scale(fix, 0.5));
      sim.pos[i - 1] = add(sim.pos[i - 1], scale(fix, 0.5));
    }
  }
}

function add(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale(a: V3, k: number): V3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}
function clampLength(v: V3, max: number): V3 {
  const n = Math.hypot(...v);
  return n > max ? scale(v, max / n) : v;
}
