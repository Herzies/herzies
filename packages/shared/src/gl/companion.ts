import { MathUtils, Vector3 } from "three";
import { turnToward, WALK_SPEED } from "./animation.js";

/*
 * A floating companion (a spirit, a pet) that follows its herzie about the
 * Town the way pets do in games: on a damped spring, so it trails behind,
 * overshoots a touch when the herzie stops, and catches up; drifting about
 * on its own while the herzie stands still, rather than mirroring every
 * shuffle; facing where it flies and leaning into it. All in world space,
 * independent of the herzie's own turn and squash.
 *
 * The springs are solved exactly (see Daniel Holden's "Spring-It-On",
 * theorangeduck.com/page/spring-roll-call), so the motion is the same at
 * any frame rate and can't blow up on a long frame.
 */

/** How fast it follows a walking herzie (Hz), and how bouncily: under 1
 * overshoots a little when the herzie stops. */
const FOLLOW_FREQUENCY = 1.1;
const FOLLOW_DAMPING = 0.6;
/** Lazier while the herzie stands still: it drifts rather than darts. */
const IDLE_FREQUENCY = 0.45;
const IDLE_DAMPING = 0.85;
/** Height has its own, softer spring: it rises and settles in its own time. */
const LIFT_FREQUENCY = 0.8;
const LIFT_DAMPING = 0.75;
/** Never faster than this (world units a second), however far behind. */
const MAX_SPEED = WALK_SPEED * 1.8;
/** Further than this from where it should be, it hurries (follows this many
 * times faster). In world units, at the herzie's size 1. */
const LEASH = 3;
const LEASH_HURRY = 2;
/** Further than this (a teleport, a respawn, a first sighting), it's simply
 * there. */
const SNAP_DISTANCE = 10;
/** A frame longer than this (the Town was hidden) puts it straight back.
 * Shorter hitches (a shader compiling) it simply flies through: the springs
 * are exact, so a long step is as steady as many short ones. */
const MAX_DT = 1;
/** Standing still, the herzie can shuffle this far (its slot moves this
 * much) before the companion bothers to follow: a pet, not a homing
 * missile. */
const DEADZONE = 0.6;
/** Below this ground speed the herzie counts as standing still. */
const STILL_SPEED = 0.3;
/** How quickly it settles into idling, and out of it, per second. */
const IDLE_BLEND_RATE = 1.2;
/** While idle it wanders to a new spot this near its slot (horizontally,
 * and up or down), every WANDER_MIN..WANDER_MAX seconds. */
const WANDER_RADIUS = 0.4;
const WANDER_LIFT = 0.18;
const WANDER_MIN = 2;
const WANDER_MAX = 4.5;
/** How lazily its slot swings round when the herzie turns (per second), so
 * a spin on the spot sends it round in an arc, not a snap. */
const SLOT_TURN_RATE = 3;
/** Flying faster than this, it faces the way it flies. */
const FACE_TRAVEL_SPEED = 0.6;
/** Otherwise it looks at a point this far in front of the herzie. */
const LOOK_AHEAD = 2.5;
const FACE_TURN_RATE = 5;
const FACE_MAX_TURN_SPEED = 7;
/** Lean (radians) per unit of acceleration, the most it leans, and how
 * smoothly the lean follows. */
const LEAN_PER_ACCEL = 0.025;
const MAX_LEAN = 0.22;
const LEAN_RATE = 8;

export type CompanionState = {
  /** Where it is (world space), and how fast it's going. */
  position: Vector3;
  velocity: Vector3;
  /** Which way it faces: forward is (sin, cos) on the ground. */
  heading: number;
  /** Lean forward (+, toward its heading) and to its right (+), radians. */
  pitch: number;
  roll: number;
  /** Where the herzie stands still now, and the slot it last settled on. */
  anchor: Vector3;
  /** The heading its slot is laid out by: the herzie's, lagged. */
  slotHeading: number;
  /** 0 following to 1 idling, eased. */
  idle: number;
  /** Its current idle wander, relative to the slot (slot-heading frame). */
  wander: Vector3;
  wanderIn: number;
  started: boolean;
  random: () => number;
};

/** Where the herzie is and how it's laid out, this step. */
export type CompanionHost = {
  /** The herzie's feet, world space. */
  position: Vector3;
  heading: number;
  /** World scale of the herzie (the boss is drawn bigger). */
  scale: number;
  /** Where the companion rests, relative to the feet with the herzie facing
   * +z, at scale 1. */
  slot: Vector3;
  /** Keep this far (horizontally, at scale 1) from the herzie's middle. */
  clearance: number;
  /** Dancing: stay on the slot, the dance moves it. */
  dancing?: boolean;
};

/** A small seeded PRNG (mulberry32), so a crowd's companions wander out of
 * step but each always the same way. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newCompanionState(seed = 0): CompanionState {
  return {
    position: new Vector3(),
    velocity: new Vector3(),
    heading: 0,
    pitch: 0,
    roll: 0,
    anchor: new Vector3(),
    slotHeading: 0,
    idle: 1,
    wander: new Vector3(),
    wanderIn: 0,
    started: false,
    random: seededRandom(seed),
  };
}

/**
 * One axis of a damped spring pulled toward `goal`, solved exactly over
 * `dt` (the goal held still meanwhile). `damping` under 1 overshoots.
 * Returns [position, velocity].
 */
export function springStep(
  x: number,
  v: number,
  goal: number,
  frequency: number,
  damping: number,
  dt: number,
): [number, number] {
  const omega = 2 * Math.PI * frequency;
  const y = damping * omega;
  const j0 = x - goal;
  const decay = Math.exp(-y * dt);
  if (damping >= 1) {
    // Critically damped (an overdamped spring is treated as critical: no
    // overshoot either way, and close enough for a pet).
    const j1 = v + j0 * omega;
    return [goal + (j0 + j1 * dt) * decay, (v - j1 * omega * dt) * decay];
  }
  const w = omega * Math.sqrt(1 - damping * damping);
  const a = j0;
  const b = (v + y * j0) / w;
  const c = Math.cos(w * dt);
  const s = Math.sin(w * dt);
  return [
    goal + decay * (a * c + b * s),
    decay * ((b * w - y * a) * c - (a * w + y * b) * s),
  ];
}

const goal = new Vector3();
const slot = new Vector3();
const before = new Vector3();
const scratch = new Vector3();

/** Where the slot is in the world, laid out by `heading`. */
function slotAt(out: Vector3, host: CompanionHost, heading: number) {
  const { slot: s, scale } = host;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  return out.set(
    host.position.x + (s.x * cos + s.z * sin) * scale,
    host.position.y + s.y * scale,
    host.position.z + (-s.x * sin + s.z * cos) * scale,
  );
}

function pickWander(state: CompanionState) {
  const angle = state.random() * Math.PI * 2;
  // sqrt: spread evenly over the disc, not bunched in the middle.
  const r = Math.sqrt(state.random()) * WANDER_RADIUS;
  state.wander.set(
    Math.cos(angle) * r,
    (state.random() * 2 - 1) * WANDER_LIFT,
    Math.sin(angle) * r,
  );
  state.wanderIn = WANDER_MIN + state.random() * (WANDER_MAX - WANDER_MIN);
}

/** Puts it where it should be, at rest. */
function snap(state: CompanionState, host: CompanionHost) {
  state.slotHeading = host.heading;
  slotAt(state.position, host, host.heading);
  state.anchor.copy(state.position);
  state.velocity.set(0, 0, 0);
  state.wander.set(0, 0, 0);
  state.wanderIn = WANDER_MIN * state.random();
  state.pitch = state.roll = 0;
  state.heading = keepingCompany(state, host);
  state.started = true;
}

/** The way it looks when it isn't flying anywhere: at a point in front of
 * the herzie, so it reads as keeping it company. */
function keepingCompany(state: CompanionState, host: CompanionHost): number {
  const dx =
    host.position.x +
    Math.sin(host.heading) * LOOK_AHEAD * host.scale -
    state.position.x;
  const dz =
    host.position.z +
    Math.cos(host.heading) * LOOK_AHEAD * host.scale -
    state.position.z;
  return Math.atan2(dx, dz);
}

/**
 * Moves the companion on by `dt` seconds after its herzie, at ground speed
 * `speed`. A first step, a long frame or a herzie far away puts it straight
 * on its slot; a step of 0 leaves it be.
 */
export function stepCompanion(
  state: CompanionState,
  host: CompanionHost,
  speed: number,
  dt: number,
): void {
  if (!state.started || dt > MAX_DT) {
    snap(state, host);
    return;
  }
  if (dt <= 0) return;
  const { scale } = host;

  // Its slot swings round after the herzie, rather than with it.
  state.slotHeading = turnToward(
    state.slotHeading,
    host.heading,
    SLOT_TURN_RATE,
    Number.POSITIVE_INFINITY,
    dt,
  );
  slotAt(slot, host, state.slotHeading);

  const still = speed < STILL_SPEED && !host.dancing;
  state.idle = MathUtils.damp(state.idle, still ? 1 : 0, IDLE_BLEND_RATE, dt);
  if (still) {
    // Shuffling about on the spot doesn't drag it along; a real move does.
    if (state.anchor.distanceTo(slot) > DEADZONE * scale)
      state.anchor.copy(slot);
    state.wanderIn -= dt;
    if (state.wanderIn <= 0) pickWander(state);
  } else {
    state.anchor.copy(slot);
    state.wander.set(0, 0, 0);
  }
  // Wandering, relative to the slot as the herzie faces.
  const cos = Math.cos(state.slotHeading);
  const sin = Math.sin(state.slotHeading);
  const { wander: wd } = state;
  goal
    .lerpVectors(slot, state.anchor, state.idle)
    .add(
      scratch.set(
        (wd.x * cos + wd.z * sin) * scale,
        wd.y * scale,
        (-wd.x * sin + wd.z * cos) * scale,
      ),
    );

  const away = state.position.distanceTo(goal);
  if (away > SNAP_DISTANCE * scale) {
    snap(state, host);
    return;
  }
  const hurry = MathUtils.smoothstep(away, LEASH * scale * 0.7, LEASH * scale);
  const frequency =
    MathUtils.lerp(FOLLOW_FREQUENCY, IDLE_FREQUENCY, state.idle) *
    MathUtils.lerp(1, LEASH_HURRY, hurry);
  const damping = MathUtils.lerp(FOLLOW_DAMPING, IDLE_DAMPING, state.idle);

  before.copy(state.velocity);
  const p = state.position;
  const v = state.velocity;
  const nx = springStep(p.x, v.x, goal.x, frequency, damping, dt);
  const nz = springStep(p.z, v.z, goal.z, frequency, damping, dt);
  const ny = springStep(p.y, v.y, goal.y, LIFT_FREQUENCY, LIFT_DAMPING, dt);
  // No faster than MAX_SPEED across the ground.
  let mx = nx[0] - p.x;
  let mz = nz[0] - p.z;
  const moved = Math.hypot(mx, mz);
  const most = MAX_SPEED * scale * dt;
  let vx = nx[1];
  let vz = nz[1];
  if (moved > most) {
    mx *= most / moved;
    mz *= most / moved;
    const vs = Math.hypot(vx, vz);
    if (vs > MAX_SPEED * scale) {
      vx *= (MAX_SPEED * scale) / vs;
      vz *= (MAX_SPEED * scale) / vs;
    }
  }
  p.set(p.x + mx, ny[0], p.z + mz);
  v.set(vx, ny[1], vz);

  // Never through the herzie: out to its clearance, and no further inward.
  const ox = p.x - host.position.x;
  const oz = p.z - host.position.z;
  const r = Math.hypot(ox, oz);
  const clear = host.clearance * scale;
  if (r < clear) {
    // Dead centre (it can't be, really): out to the side of its slot.
    const ux = r > 1e-6 ? ox / r : slot.x - host.position.x;
    const uz = r > 1e-6 ? oz / r : slot.z - host.position.z;
    const ul = Math.hypot(ux, uz) || 1;
    p.x = host.position.x + (ux / ul) * clear;
    p.z = host.position.z + (uz / ul) * clear;
    const inward = (v.x * ux + v.z * uz) / ul;
    if (inward < 0) {
      v.x -= (inward * ux) / ul;
      v.z -= (inward * uz) / ul;
    }
  }

  // Face where it flies; idle, keep the herzie company.
  const flying = Math.hypot(v.x, v.z);
  const target =
    flying > FACE_TRAVEL_SPEED * scale
      ? Math.atan2(v.x, v.z)
      : keepingCompany(state, host);
  state.heading = turnToward(
    state.heading,
    target,
    FACE_TURN_RATE,
    FACE_MAX_TURN_SPEED,
    dt,
  );

  // Lean into its acceleration: forward as it speeds up, into a turn.
  const ax = (v.x - before.x) / dt / scale;
  const az = (v.z - before.z) / dt / scale;
  const fs = Math.sin(state.heading);
  const fc = Math.cos(state.heading);
  // Its right, facing (sin, cos) with y up: (−cos, sin).
  const forward = ax * fs + az * fc;
  const right = -ax * fc + az * fs;
  const lean = (a: number) =>
    MathUtils.clamp(a * LEAN_PER_ACCEL, -MAX_LEAN, MAX_LEAN);
  state.pitch = MathUtils.damp(state.pitch, lean(forward), LEAN_RATE, dt);
  state.roll = MathUtils.damp(state.roll, lean(right), LEAN_RATE, dt);
}
