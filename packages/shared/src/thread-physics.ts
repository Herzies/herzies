/**
 * Things hung off a herzie's back on threads: the Record Slinger's discs,
 * the first tied to the middle of its back, the next tied to the first.
 *
 * Unlike the chain's one spring angle (dangle-physics.ts), this is a little
 * chain of weights: each a point, Verlet-integrated, on a thread that can go
 * slack but never stretch, and kept riding on the back rather than through
 * it. What swings them is the herzie moving, felt from its own frame: it
 * speeds up and they lag; it stops and they swing on; it turns and they're
 * flung out and trail behind; its walk bob jolts the thread's knot.
 *
 * Creature space throughout (y down, front −z). Pure: HerzieModel owns a
 * ThreadSim and steps it each frame.
 */

type V3 = [number, number, number];

/** How a chain of weights hangs: built with the herzie (see the renderer's
 * buildCompactDiscs). */
export interface ThreadRig {
  /** Where the first thread is tied, at rest. */
  knot: V3;
  /** Each weight's thread: from the knot for the first, from the weight
   * before it for the rest. */
  lengths: number[];
  /** Where each weight hangs at rest: settled (see settleThread). */
  rest: V3[];
  /** The torso they hang against, at rest… */
  center: V3;
  /** …and how far each weight's centre keeps from its middle. */
  clear: number[];
  /** Which held part each weight is. */
  parts: string[];
}

/** What moves the herzie, this step. */
export interface ThreadInput {
  /** How far the torso (and the knot with it) is moved from rest by the
   * pose — its walk bob, its dance. */
  offset: V3;
  /** Its acceleration, in creature units/s², creature space. */
  accel: V3;
  /** How fast it turns about its vertical (creature y), rad/s. */
  turnRate: number;
  /** How fast it's going, creature units/s, creature space: the air it
   * moves through blows the weights back (see ThreadConfig's drag). */
  velocity?: V3;
}

export interface ThreadSim {
  pos: V3[];
  prev: V3[];
  /** Turn rate at the last substep, for the turn's own speeding up. */
  turnRate: number;
  /** The torso's offset last step, and how fast it was moving: the
   * weights ride its bob, feeling only its jolts (by `response`). */
  offset: V3;
  bobVelocity: V3;
}

/** How the threads feel. Tuned in the sandbox (as the chain's is). */
export interface ThreadConfig {
  /** Pull of gravity, creature units/s² (+y is down): heavier swings
   * quicker and hangs harder. */
  gravity: number;
  /** How quickly a swing dies away, per second. Light: it should swing on
   * a while after the herzie stops, as a chain does. */
  damping: number;
  /** How hard the air of its going blows the weights back, per unit
   * speed: walking, they trail out a little behind it. */
  drag: number;
  /** How much of the herzie's moving (speeding up, turning) the weights
   * feel at all, 0 to 1: lower and they sit calmer on the back. */
  response: number;
}

export const DEFAULT_THREAD_CONFIG: ThreadConfig = {
  gravity: 70,
  damping: 8,
  drag: 6,
  response: 0.55,
};
/** The most acceleration and turn the threads feel (a teleport, a portal's
 * spin, a dropped frame mustn't fling them across the map). */
const MAX_ACCEL = 25;
const MAX_TURN = 8;
/** Time constant (s) a change of turn rate is felt over. */
const TURN_EASE = 0.12;
const MAX_SPEED = 12;

// As dangle-physics: a fixed substep, so a long frame can't blow it up.
const SUBSTEP = 1 / 240;
const MAX_SUBSTEPS = 24;
/** Constraint passes per substep: enough for two weights to sit still. */
const PASSES = 3;

export function createThreadSim(rig: ThreadRig): ThreadSim {
  return {
    pos: rig.rest.map((p) => [...p] as V3),
    prev: rig.rest.map((p) => [...p] as V3),
    turnRate: 0,
    offset: [0, 0, 0],
    bobVelocity: [0, 0, 0],
  };
}

/** Advances it `dt` seconds. */
export function stepThreadSim(
  sim: ThreadSim,
  rig: ThreadRig,
  dt: number,
  input: ThreadInput,
  config: ThreadConfig = DEFAULT_THREAD_CONFIG,
): void {
  if (dt <= 0) return;
  const steps = Math.min(MAX_SUBSTEPS, Math.ceil(dt / SUBSTEP));
  const h = dt / steps;
  // The torso's bob carries them along with it (rather than yanking them by
  // the knot), and its jolts are felt like any other speeding up.
  const carry = sub(input.offset, sim.offset);
  const bobVelocity = scale(carry, 1 / dt);
  const bobAccel = scale(sub(bobVelocity, sim.bobVelocity), 1 / dt);
  sim.offset = [...input.offset];
  sim.bobVelocity = bobVelocity;
  sim.pos = sim.pos.map((p) => add(p, carry));
  sim.prev = sim.prev.map((p) => add(p, carry));
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
  const center = add(rig.center, input.offset);
  const knot = add(rig.knot, input.offset);
  const keep = Math.exp(-config.damping * h);
  for (let s = 0; s < steps; s++) {
    // The turn eases toward its new rate over a moment, not a frame: a
    // herzie snapping round to walk the other way mustn't fling them.
    const w =
      sim.turnRate + (turn - sim.turnRate) * (1 - Math.exp(-h / TURN_EASE));
    const spinUp = (w - sim.turnRate) / h;
    sim.pos.forEach((p, i) => {
      const v = scale(sub(p, sim.prev[i]), 1 / h);
      // Felt from the herzie's frame, turning about its vertical through
      // the torso: gravity, less its own acceleration, the turn's fling
      // out (centrifugal), lag as it speeds up (Euler), Coriolis — and the
      // air it's going through.
      const r = sub(p, center);
      // Turning, the back sweeps through the air too: that blows them
      // back against the turn, so they keep trailing it.
      const sweep = config.drag * w;
      const a: V3 = [
        wind[0] -
          sweep * r[2] -
          accel[0] +
          w * w * r[0] -
          spinUp * r[2] -
          2 * w * v[2],
        wind[1] + config.gravity - accel[1],
        wind[2] +
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
    for (let pass = 0; pass < PASSES; pass++) {
      constrain(sim, rig, knot, center);
    }
    // Last, from the knot down, each weight alone brought back in: no thread
    // ends a step stretched, however hard it was yanked.
    sim.pos.forEach((p, i) => {
      const tied = i === 0 ? knot : sim.pos[i - 1];
      const d = sub(p, tied);
      const length = Math.hypot(...d);
      if (length > rig.lengths[i]) {
        sim.pos[i] = add(tied, scale(d, rig.lengths[i] / length));
      }
    });
  }
}

/** The weights where they hang at rest, nothing moving them: what the model
 * is built with, so still views show them as they'd really hang. */
export function settleThread(rig: ThreadRig, seconds = 4): V3[] {
  const sim = createThreadSim(rig);
  const still: ThreadInput = {
    offset: [0, 0, 0],
    accel: [0, 0, 0],
    turnRate: 0,
  };
  for (let t = 0; t < seconds; t += 0.05) {
    stepThreadSim(sim, rig, 0.05, still);
    // Heavily damped while settling: only where it ends up matters.
    sim.prev = sim.prev.map((p, i) => lerp(p, sim.pos[i], 0.5));
  }
  return sim.pos;
}

/** Each weight's displacement from where it hangs at rest, less the torso's
 * own (`offset`): what the renderer swings it by. */
export function threadSway(sim: ThreadSim, rig: ThreadRig, offset: V3): V3[] {
  return sim.pos.map((p, i) => sub(p, add(rig.rest[i], offset)));
}

/** Nothing on the threads is moving to speak of. */
export function isThreadSettled(sim: ThreadSim): boolean {
  return sim.pos.every((p, i) => Math.hypot(...sub(p, sim.prev[i])) < 1e-5);
}

function constrain(sim: ThreadSim, rig: ThreadRig, knot: V3, center: V3) {
  // Riding on the back, not through it…
  sim.pos.forEach((p, i) => {
    const d = sub(p, center);
    const at = Math.hypot(...d);
    if (at < rig.clear[i] && at > 1e-9) {
      sim.pos[i] = add(center, scale(d, rig.clear[i] / at));
    }
  });
  // …then the threads, from the bottom up, so the knot's has the last word:
  // slack is fine, stretched isn't.
  for (let i = sim.pos.length - 1; i >= 0; i--) {
    const p = sim.pos[i];
    const tied = i === 0 ? knot : sim.pos[i - 1];
    const d = sub(p, tied);
    const length = Math.hypot(...d);
    const max = rig.lengths[i];
    if (length <= max) continue;
    const fix = scale(d, (length - max) / length);
    if (i === 0) sim.pos[0] = sub(p, fix);
    else {
      // The weight above gives too: it's hung, not nailed.
      sim.pos[i] = sub(p, scale(fix, 0.5));
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
function lerp(a: V3, b: V3, t: number): V3 {
  return add(a, scale(sub(b, a), t));
}
function clampLength(v: V3, max: number): V3 {
  const n = Math.hypot(...v);
  return n > max ? scale(v, max / n) : v;
}
