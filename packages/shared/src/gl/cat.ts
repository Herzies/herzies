import { MathUtils, Vector3 } from "three";
import { angleDelta, turnToward, WALK_SPEED } from "./animation.js";
import { seededRandom } from "./companion.js";

/*
 * Sleptwell, the cat spirit: a companion that walks after its herzie rather
 * than floating. Its brain, kept apart from its body (catModel.ts) so it can
 * be tested on its own.
 *
 * How it moves follows what games do with pets that walk:
 *  - It steers by heading: it turns at a limited rate and walks forward at a
 *    speed sprung toward where it wants to be, so it arcs into turns rather
 *    than sliding sideways like a floating spirit.
 *  - Its gait advances by the ground it covers (phase += distance / stride),
 *    never by time, so its feet don't skate; walk or trot by its own speed.
 *  - It follows with hysteresis and a beat of reaction: it gets up when the
 *    herzie is a little way off, and settles once it's close, rather than
 *    chasing every shuffle.
 *  - Its spot is behind and beside the herzie, led by the herzie's velocity,
 *    so it doesn't trail on a straight run.
 *  - Left be, it settles down a step at a time, each eased both ways: stand,
 *    sit, lie down, and (the herzie away) curl up asleep. From lying it
 *    stretches before it trots off.
 *  - The head leads, ears first; the tail follows through as a springy chain.
 *
 * All world space, frame-rate independent (the springs are solved exactly,
 * as companion.ts's are), and allocation-free per step: a crowd's cats run.
 */

// --- Size and placement -----------------------------------------------------

/** Nose to rump, in world units at the herzie's size 1. */
export const CAT_LENGTH = 1.15;
/** Its spot, relative to the herzie (facing +z): this far out to the
 * herzie's right beyond its clearance, and this far back. */
const SLOT_SIDE = 0.7;
const SLOT_BACK = 0.5;
/** Its spot is led by the herzie's velocity this many seconds ahead. */
const SLOT_LEAD = 0.3;
/** How lazily its spot swings round when the herzie turns (per second). */
const SLOT_TURN_RATE = 2.5;

// --- Following --------------------------------------------------------------

/** Walking, it follows the herzie's own footsteps (a trail of them, this
 * far apart), so it goes where the herzie could: round walls and water,
 * never stuck against them. It keeps this far behind (beyond the herzie's
 * clearance), along the path. */
const TRAIL_SPACING = 0.3;
const TRAIL_CAP = 160;
const BEHIND_GAP = 0.85;
/** It counts a footstep reached within this. */
const TRAIL_REACH = 0.45;
/** It cuts a corner to a footstep this many ahead when the way is clear. */
const TRAIL_SHORTCUT = 6;
/** It gets up to follow once it's this much further behind than its gap. */
const TRAIL_SLACK = 1.2;
/** The herzie stopped this long, it moves up beside it, if there's room
 * (the way there clear, and the spot dry); else it stays behind. */
const SIDE_AFTER = 0.9;
/** Getting nowhere this long (closing less than STUCK_PROGRESS), it gives
 * up: off the herzie's side and back behind; or, far behind, it reappears
 * RESPAWN_TRAIL back along the herzie's path, out of sight, and trots in. */
const STUCK_SECONDS = 1.6;
const STUCK_PROGRESS = 0.25;
const RESPAWN_TRAIL = 6;

/** Within this much of its gap it ambles rather than trots. */
const START_RADIUS = 1.9;
/** Beside the herzie: this far out beyond its clearance, this far back. */
const SIDE_OUT = 0.55;
const SIDE_BACK = 0.15;
/** A beat before it reacts (seconds, picked between these). */
const REACT_MIN = 0.15;
const REACT_MAX = 0.4;
/** Its own walking pace, its trot, and its dash when far behind (world
 * units a second at size 1). The trot outpaces a walking herzie. */
const WALK_PACE = 1.8;
const TROT_PACE = WALK_SPEED * 1.3;
const DASH_PACE = WALK_SPEED * 1.85;
/** The herzie's sprint (town-net's TOWN_SPRINT_SPEED): leaving at this
 * pace, the cat hurries all it can — up at once, no stretch, and fast. */
const SPRINT_SPEED = 6;
/** Hurrying, it always outpaces the herzie by this much. */
const OUTPACE = 1.2;
/** Further behind than this, it dashes. */
const LEASH = 5;
/** How quickly it speeds up to close the gap (per second of gap). */
const ARRIVE_GAIN = 2.2;
/** How its speed follows what it wants (Hz, critically damped): it
 * picks up gently, and brakes harder. */
const SPEED_FREQUENCY = 1.5;
const BRAKE_FREQUENCY = 2.6;
/** How fast it turns: eased at this rate, never faster than TURN_STILL
 * radians a second standing, TURN_FAST at a trot (it arcs). */
const TURN_RATE = 7;
const TURN_STILL = 6;
const TURN_FAST = 2.4;
/** More than this off its heading and slow, it turns on the spot first. */
const TURN_IN_PLACE = 1.6;
/** Further than this from the herzie (a teleport, a respawn), it reappears
 * RESPAWN_DISTANCE away behind and to the side, and trots in. */
const SNAP_DISTANCE = 16;
const RESPAWN_DISTANCE = 7.5;
const RESPAWN_ANGLE = 2.3;
/** A frame longer than this (the Town was hidden) puts it on its spot. */
const MAX_DT = 1;

// --- Gait -------------------------------------------------------------------

/** Ground covered by one full gait cycle (all four feet), walking and
 * trotting, at size 1. */
const STRIDE_WALK = 0.62;
const STRIDE_TROT = 1.1;
/** It trots from this speed, fully by TROT_FULL. */
const TROT_FROM = 2.3;
const TROT_FULL = 3.6;
/** Turning on the spot, its feet step this many cycles per radian. */
const TURN_STEPS = 0.22;

// --- Resting ----------------------------------------------------------------

/** Rest levels: what it eases between. */
export const REST_STAND = 0;
export const REST_SIT = 1;
export const REST_LIE = 2;
export const REST_SLEEP = 3;
/** The herzie still this long (seconds): it sits, lies down, sleeps. */
const SIT_AFTER = 3.5;
const LIE_AFTER = 14;
const SLEEP_AFTER = 50;
/** On a bench, the herzie: it lies down nearby after this long. */
const BENCH_LIE_AFTER = 1.5;
/** How quickly it settles down, and gets back up (Hz, critically damped).
 * Down is slow and deliberate; up is brisker. */
const REST_DOWN_FREQUENCY = 0.4;
const REST_UP_FREQUENCY = 0.9;
/** Getting up from lying: a stretch this long before it walks. */
const STRETCH_SECONDS = 1.1;
/** Waking from sleep, it yawns this long (during the stretch). */
const YAWN_SECONDS = 1.3;

// --- Little life ------------------------------------------------------------

const BLINK_SECONDS = 0.16;
/** Looking at the herzie: how long when it sets off, and now and then of
 * its own accord (how long, and how far apart). */
const WATCH_SETTING_OFF = 1.6;
const WATCH_SECONDS = [1.5, 4] as const;
const WATCH_EVERY = [6, 16] as const;
const GROOM_SECONDS = 2.6;
const FLICK_SECONDS = 0.45;
const TWITCH_SECONDS = 0.25;

// --- Fetching ---------------------------------------------------------------

/** It pounces from this far (its nose's reach) off the item. */
const POUNCE_REACH = 0.75;
/** The pounce: crouch and wiggle, leap, land (fractions of POUNCE_SECONDS). */
const POUNCE_SECONDS = 0.7;
const POUNCE_LEAP = 0.45;
const POUNCE_LAND = 0.8;
const POUNCE_HOP = 0.22;
/** Back from a fetch within this of its spot, it's following as usual. */
const RETURNED_RADIUS = 1.4;

// --- Tail -------------------------------------------------------------------

/** Segments in its tail (the model has as many bones). */
export const TAIL_SEGMENTS = 6;

/** Its herzie's prop (see CatHost.prop): how near the herzie it has to be
 * to go to it. It goes up on it (beside it only if it can't get up). */
const PROP_REACH = 3.5;
/** How many spots round it it tries, and how many times it tries again
 * when it can't get to one. */
const PROP_SPOTS = 16;
const PROP_RETRIES = 3;
/** How far its body reaches out to the side (what it keeps off the prop),
 * and how close it settles against it, alongside (its side this far off
 * the edge). */
const BODY_RADIUS = 0.2;
const PROP_SNUG = 0.04;
/** Where it walks up to, nose first, to settle beside it or jump up on
 * it: this far off its edge (its nose clear). */
const PROP_BESIDE = 0.7;
const PROP_TAKEOFF = 0.75;
/** How fast it shuffles in against it as it settles (at size 1). */
const SNUG_PACE = 0.5;
/** How long a hop up or down takes (on the pounce's timeline: crouch,
 * leap, land). */
const HOP_SECONDS = 0.75;

export type CatFetch = "none" | "going" | "pounce" | "holding" | "returning";

export type CatState = {
  /** Its feet (world space), heading (forward is (sin, cos)), and forward
   * speed (world units a second). */
  position: Vector3;
  heading: number;
  speed: number;
  speedVelocity: number;
  /** How fast its heading is turning (radians a second, smoothed). */
  turnRate: number;
  /** Through its gait cycle, 0..1, by distance. */
  phase: number;
  /** 0 standing to 1 walking, and 0 walking to 1 trotting, eased. */
  moving: number;
  trot: number;
  /** Following its spot (else settled where it is). */
  following: boolean;
  /** Seconds left before it reacts; −1 when nothing's pending. */
  react: number;
  /** How long the herzie's been still (seconds). */
  still: number;
  /** Its rest level (REST_*), continuous: eased between levels. */
  rest: number;
  restVelocity: number;
  restTarget: number;
  /** Seconds into a stretch (getting up from lying), −1 when not. */
  stretch: number;
  /** Seconds into a yawn, −1 when not. */
  yawn: number;
  /** Seconds into grooming a paw, −1 when not; and until the next try. */
  groom: number;
  groomIn: number;
  /** The herzie's velocity (world units a second), smoothed, and where it
   * was last step. */
  hostVelocity: Vector3;
  hostLast: Vector3;
  /** Its spot's heading: the herzie's, lagged. */
  slotHeading: number;
  /** Head turn (+: to its left) and tilt (+: up), relative to its body; and
   * its ears', which lead the head. Radians. */
  headYaw: number;
  headYawVelocity: number;
  headPitch: number;
  headPitchVelocity: number;
  earYaw: number;
  earYawVelocity: number;
  /** Looking at the herzie: for how much longer, and until it next does
   * of its own accord; and whether the herzie was walking last step (it
   * looks round when it sets off). */
  watchFor: number;
  watchIn: number;
  hostWasMoving: boolean;
  /** Looking somewhere of its own accord (a glance), and for how long. */
  glanceYaw: number;
  glanceFor: number;
  glanceIn: number;
  /** 0 open to 1 shut (a blink's progress, −1 between blinks). */
  blink: number;
  blinkIn: number;
  /** An ear's twitch: which (−1 left, 1 right), and how far in (−1: none). */
  twitchEar: number;
  twitch: number;
  twitchIn: number;
  /** A flick of the tail's tip (seconds in, −1: none). */
  flick: number;
  flickIn: number;
  /** The tail: each segment's side-to-side (yaw) and up-down (pitch) bend,
   * relative to the one before, and how fast each is moving. */
  tailYaw: Float32Array;
  tailYawVelocity: Float32Array;
  tailPitch: Float32Array;
  tailPitchVelocity: Float32Array;
  /** Tilt to the ground under it (radians; + nose up, + right side up),
   * and a lean into turns. */
  slopePitch: number;
  slopeRoll: number;
  lean: number;
  /** Ground height under it, sprung (so a step up is eased). */
  groundVelocity: number;
  /** Seconds it's been alive (breathing, idle swishes). */
  clock: number;
  /** Off to fetch something (world space), or null. */
  target: Vector3 | null;
  fetch: CatFetch;
  /** Seconds into its pounce; where it leapt from and where it lands. */
  pounce: number;
  pounceFrom: Vector3;
  pounceTo: Vector3;
  /** Something nearby to look at instead (Nakata); null for none. */
  glanceAt: Vector3 | null;
  /** Which way it curls up and wraps its tail (+1 or −1): its habit. */
  side: number;
  /** The herzie's footsteps, (x, z) pairs in a ring: `trailHead` written
   * so far, `trailNext` the next it heads for (both counted from 0). */
  trail: Float32Array;
  trailHead: number;
  trailNext: number;
  /** Beside the still herzie: where (sideOn), and whether it's looked for
   * room yet this stop. */
  sideOn: boolean;
  sideTried: boolean;
  sideGoal: Vector3;
  /** Its herzie's prop (see CatHost.prop): what it's off to do there
   * (settle beside it, or get up on it, or first round the herzie to get
   * to it), and whether it's up on it now. */
  propPlan: "none" | "beside" | "on" | "around";
  perched: boolean;
  /** Spots by the prop it's tried this stop, whether it's given up on it
   * till the herzie next moves, and until it next looks for a way. */
  propTries: number;
  propGaveUp: boolean;
  propIn: number;
  /** Home (see catToHome): hurrying there (up on the prop, or down beside
   * the herzie); just gone there (it picks where next step); whether the
   * herzie has a prop to get up on (else it lies down beside it); and
   * `lieDown`: off to, or lying beside the herzie, Home's way. */
  homeRush: boolean;
  homeStart: boolean;
  homeProp: boolean;
  lieDown: boolean;
  /** Seconds into a hop up onto the prop or down off it (−1: not
   * hopping); where from and to, heights and all; and which way. */
  hop: number;
  hopFrom: Vector3;
  hopTo: Vector3;
  hopUp: boolean;
  /** Getting nowhere: for how long, and the closest it's got. */
  stuckFor: number;
  stuckBest: number;
  started: boolean;
  random: () => number;
};

/** Where the herzie is, and what it's doing, this step. */
export type CatHost = {
  /** The herzie's feet, world space. */
  position: Vector3;
  heading: number;
  /** World scale of the herzie. */
  scale: number;
  /** How far out from the herzie's middle its body reaches (size 1). */
  clearance: number;
  dancing?: boolean;
  /** On a seat. */
  sitting?: boolean;
  /** Away from the keyboard: it curls up asleep. */
  afk?: boolean;
  /** The land's height at a point; the herzie's feet when not given. */
  groundAt?: (x: number, z: number) => number;
  /** Whether it can walk there (not water); everywhere when not given. */
  walkable?: (x: number, z: number) => boolean;
  /** Whether it can walk straight from (ax, az) to (bx, bz): nothing in
   * the way (a wall, a tree) and no water. Without it, only water counts
   * (sampled with `walkable`). */
  clear?: (ax: number, az: number, bx: number, bz: number) => boolean;
  /** Something of the herzie's standing on the ground (its boombox): it
   * walks round it, not through it, and when the herzie stops it sometimes
   * settles beside it and sometimes hops up and sits on it. */
  prop?: CatProp | null;
  /** At Home: the way to the camera (a heading). It comes in from behind
   * the herzie, away from it, and lies facing it. */
  facing?: number | null;
};

/** A prop on the ground (see CatHost.prop): a circle round its middle, and
 * the height of its top, world space; and, if it's set out to be seen
 * (Home's boombox), the way to the camera (a heading): up on it, it faces
 * that way, and it goes round the back to get up there, out of the way. */
export type CatProp = {
  x: number;
  z: number;
  r: number;
  top: number;
  facing?: number;
};

export function newCatState(seed = 0): CatState {
  const random = seededRandom(seed);
  return {
    position: new Vector3(),
    heading: 0,
    speed: 0,
    speedVelocity: 0,
    turnRate: 0,
    phase: random(),
    moving: 0,
    trot: 0,
    following: false,
    react: -1,
    still: 0,
    rest: 0,
    restVelocity: 0,
    restTarget: 0,
    stretch: -1,
    yawn: -1,
    groom: -1,
    groomIn: 6 + random() * 8,
    hostVelocity: new Vector3(),
    hostLast: new Vector3(),
    slotHeading: 0,
    headYaw: 0,
    headYawVelocity: 0,
    headPitch: 0,
    headPitchVelocity: 0,
    earYaw: 0,
    earYawVelocity: 0,
    watchFor: 0,
    watchIn: 3 + random() * 6,
    hostWasMoving: false,
    glanceYaw: 0,
    glanceFor: 0,
    glanceIn: 2 + random() * 4,
    blink: -1,
    blinkIn: 1 + random() * 3,
    twitchEar: 1,
    twitch: -1,
    twitchIn: 2 + random() * 6,
    flick: -1,
    flickIn: 2 + random() * 4,
    tailYaw: new Float32Array(TAIL_SEGMENTS),
    tailYawVelocity: new Float32Array(TAIL_SEGMENTS),
    tailPitch: new Float32Array(TAIL_SEGMENTS),
    tailPitchVelocity: new Float32Array(TAIL_SEGMENTS),
    slopePitch: 0,
    slopeRoll: 0,
    lean: 0,
    groundVelocity: 0,
    clock: random() * 10,
    target: null,
    fetch: "none",
    pounce: 0,
    pounceFrom: new Vector3(),
    pounceTo: new Vector3(),
    glanceAt: null,
    side: random() < 0.5 ? -1 : 1,
    trail: new Float32Array(TRAIL_CAP * 2),
    trailHead: 0,
    trailNext: 0,
    sideOn: false,
    sideTried: false,
    sideGoal: new Vector3(),
    propPlan: "none",
    perched: false,
    propTries: 0,
    propGaveUp: false,
    propIn: 0,
    homeRush: false,
    homeStart: false,
    homeProp: false,
    lieDown: false,
    hop: -1,
    hopFrom: new Vector3(),
    hopTo: new Vector3(),
    hopUp: false,
    stuckFor: 0,
    stuckBest: Number.POSITIVE_INFINITY,
    started: false,
    random,
  };
}

/** The velocity springTo last left (springTo returns the position). */
let springVelocity = 0;

/** One axis of a damped spring toward `goal`, solved exactly over `dt`
 * (as companion.ts's springStep, without the tuple). */
function springTo(
  x: number,
  v: number,
  goal: number,
  frequency: number,
  damping: number,
  dt: number,
): number {
  const omega = 2 * Math.PI * frequency;
  const y = damping * omega;
  const j0 = x - goal;
  const decay = Math.exp(-y * dt);
  if (damping >= 1) {
    const j1 = v + j0 * omega;
    springVelocity = (v - j1 * omega * dt) * decay;
    return goal + (j0 + j1 * dt) * decay;
  }
  const w = omega * Math.sqrt(1 - damping * damping);
  const b = (v + y * j0) / w;
  const c = Math.cos(w * dt);
  const s = Math.sin(w * dt);
  springVelocity = decay * ((b * w - y * j0) * c - (j0 * w + y * b) * s);
  return goal + decay * (j0 * c + b * s);
}

/** Smooth 0→1→0 over [0, 1]. */
function bump(t: number): number {
  return t <= 0 || t >= 1 ? 0 : Math.sin(t * Math.PI);
}

/** How far in (0..1) a stretch, a yawn, a groom… is, by the seconds since
 * it started; 0 when it isn't happening. */
export function envelope(seconds: number, length: number): number {
  return seconds < 0 ? 0 : bump(seconds / length);
}

const slot = new Vector3();

/** Its spot in the world, laid out by `heading`, led by the herzie's
 * velocity. */
function slotAt(state: CatState, host: CatHost, heading: number) {
  const k = host.scale;
  const side = -(host.clearance + SLOT_SIDE) * k;
  const back = -SLOT_BACK * k;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  return slot.set(
    host.position.x +
      side * cos +
      back * sin +
      state.hostVelocity.x * SLOT_LEAD,
    host.position.y,
    host.position.z -
      side * sin +
      back * cos +
      state.hostVelocity.z * SLOT_LEAD,
  );
}

function groundAt(host: CatHost, x: number, z: number): number {
  return host.groundAt ? host.groundAt(x, z) : host.position.y;
}

function walkable(host: CatHost, x: number, z: number): boolean {
  if (onProp(host, x, z)) return false;
  return host.walkable ? host.walkable(x, z) : true;
}

/** Whether a cat standing at (x, z) would be in its herzie's prop. */
function onProp(host: CatHost, x: number, z: number): boolean {
  const p = host.prop;
  if (!p) return false;
  return Math.hypot(x - p.x, z - p.z) < p.r + BODY_RADIUS * host.scale;
}

/** How far its body runs fore and aft of where it stands (at size 1). */
const BODY_HALF = CAT_LENGTH * 0.42;

/** Pushes it out of the prop, its whole body (nose to rump, BODY_RADIUS
 * thick) clear of it. */
function keepOffProp(state: CatState, host: CatHost) {
  const p = host.prop;
  if (!p) return;
  const k = host.scale;
  const fs = Math.sin(state.heading);
  const fc = Math.cos(state.heading);
  const half = BODY_HALF * k;
  // The nearest point of its spine to the prop's middle.
  const t = MathUtils.clamp(
    (p.x - state.position.x) * fs + (p.z - state.position.z) * fc,
    -half,
    half,
  );
  const cx = state.position.x + fs * t;
  const cz = state.position.z + fc * t;
  const ox = cx - p.x;
  const oz = cz - p.z;
  const d = Math.hypot(ox, oz);
  const clear = p.r + BODY_RADIUS * k;
  if (d >= clear) return;
  // Straight out from the prop; dead on its middle, out sideways.
  const ux = d > 1e-6 ? ox / d : -fc;
  const uz = d > 1e-6 ? oz / d : fs;
  state.position.x += ux * (clear - d);
  state.position.z += uz * (clear - d);
}

/** Whether walking straight from a to b goes through the prop. */
function throughProp(
  host: CatHost,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): boolean {
  const p = host.prop;
  if (!p) return false;
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t =
    len2 > 1e-9
      ? MathUtils.clamp(((p.x - ax) * dx + (p.z - az) * dz) / len2, 0, 1)
      : 0;
  return onProp(host, ax + dx * t, az + dz * t);
}

/** Whether it can walk straight from a to b (see CatHost.clear). */
function pathClear(
  host: CatHost,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): boolean {
  if (throughProp(host, ax, az, bx, bz)) return false;
  if (host.clear) return host.clear(ax, az, bx, bz);
  if (!host.walkable) return true;
  const d = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.ceil(d / 0.3));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (!host.walkable(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
  }
  return true;
}

/** Picks a spot beside the still herzie with room to get to: on the side
 * it's on first, else the other. False if neither. */
function pickSide(state: CatState, host: CatHost): boolean {
  const k = host.scale;
  const fs = Math.sin(host.heading);
  const fc = Math.cos(host.heading);
  // The herzie's right, facing (sin, cos) with y up: (−cos, sin).
  const rx = -fc;
  const rz = fs;
  const onRight =
    (state.position.x - host.position.x) * rx +
      (state.position.z - host.position.z) * rz >=
    0;
  const out = (host.clearance + SIDE_OUT) * k;
  const back = SIDE_BACK * k;
  for (const side of onRight ? [1, -1] : [-1, 1]) {
    const x = host.position.x + rx * out * side - fs * back;
    const z = host.position.z + rz * out * side - fc * back;
    if (
      walkable(host, x, z) &&
      pathClear(host, state.position.x, state.position.z, x, z)
    ) {
      state.sideGoal.set(x, host.position.y, z);
      return true;
    }
  }
  return false;
}

/**
 * Off to the herzie's prop, if it's near the herzie: to hop up on it, else
 * (no way to a run-up) to settle beside it. Looks for a spot all round it,
 * nearest the cat first: one it can walk straight to, with room — not
 * crowding the herzie, nor past it to get there. `avoid`: not near there
 * (the spot it just couldn't get to). False if there's no prop or no spot.
 */
function pickProp(
  state: CatState,
  host: CatHost,
  avoid: Vector3 | null = null,
  /** In a hurry (Home): the nearest way up, not round the back. */
  hurry = false,
): boolean {
  const p = host.prop;
  if (!p) return false;
  const k = host.scale;
  if (Math.hypot(p.x - host.position.x, p.z - host.position.z) > PROP_REACH * k)
    return false;
  // Round from its back (away from the camera), else from the cat's side.
  const start =
    p.facing !== undefined && !hurry
      ? p.facing + Math.PI
      : Math.atan2(state.position.x - p.x, state.position.z - p.z);
  const room = (host.clearance + BODY_RADIUS + 0.15) * k;
  const passBy = host.clearance * k;
  /** A spot `out` off its edge at `a` it can walk straight to: goes. */
  const tryAt = (a: number, out: number, plan: "on" | "beside") => {
    const x = p.x + Math.sin(a) * out;
    const z = p.z + Math.cos(a) * out;
    if (Math.hypot(x - host.position.x, z - host.position.z) < room)
      return false;
    if (avoid && Math.hypot(x - avoid.x, z - avoid.z) < 0.4 * k) return false;
    if (
      segmentNear(
        host.position.x,
        host.position.z,
        state.position.x,
        state.position.z,
        x,
        z,
      ) < passBy
    )
      return false;
    if (
      !walkable(host, x, z) ||
      !pathClear(host, state.position.x, state.position.z, x, z)
    )
      return false;
    state.sideGoal.set(x, host.position.y, z);
    state.propPlan = plan;
    return true;
  };
  // 0, +1, −1, +2, −2, … steps round from `start`: the back half first.
  const angle = (i: number) =>
    start + (Math.ceil(i / 2) * (i % 2 ? 1 : -1) * Math.PI * 2) / PROP_SPOTS;
  const half = PROP_SPOTS / 2;
  const up = p.r + PROP_TAKEOFF * k;
  for (let i = 0; i <= half; i++) if (tryAt(angle(i), up, "on")) return true;
  // Set out to be seen: round the back of the herzie rather than up from
  // the front (unless it's there already).
  if (p.facing !== undefined && !hurry && aroundHerzie(state, host, p))
    return true;
  for (let i = half + 1; i < PROP_SPOTS; i++)
    if (tryAt(angle(i), up, "on")) return true;
  const beside = p.r + PROP_BESIDE * k;
  for (let i = 0; i < PROP_SPOTS; i++)
    if (tryAt(angle(i), beside, "beside")) return true;
  return aroundHerzie(state, host, p);
}

/**
 * No straight way to the prop (the herzie's in the way): first round the
 * herzie, to a spot off its side, across the line from cat to prop —
 * the side nearer the cat first. From there it looks again.
 */
function aroundHerzie(state: CatState, host: CatHost, p: CatProp): boolean {
  const k = host.scale;
  const hx = host.position.x;
  const hz = host.position.z;
  // Across the line from the herzie to the prop.
  const a = Math.atan2(p.x - hx, p.z - hz);
  const out = (host.clearance + BODY_HALF + BODY_RADIUS) * k;
  const passBy = host.clearance * k;
  // Round the back of the herzie (away from the camera), else the side
  // nearer the cat.
  const prefer =
    p.facing !== undefined
      ? p.facing + Math.PI
      : Math.atan2(state.position.x - hx, state.position.z - hz);
  const sides = [a + Math.PI / 2, a - Math.PI / 2].sort(
    (u, v) => Math.abs(angleDelta(prefer, u)) - Math.abs(angleDelta(prefer, v)),
  );
  for (const b of sides) {
    const x = hx + Math.sin(b) * out;
    const z = hz + Math.cos(b) * out;
    // There already: no further round that way.
    if (Math.hypot(x - state.position.x, z - state.position.z) < 0.35 * k)
      continue;
    if (segmentNear(hx, hz, state.position.x, state.position.z, x, z) < passBy)
      continue;
    if (
      walkable(host, x, z) &&
      pathClear(host, state.position.x, state.position.z, x, z)
    ) {
      state.sideGoal.set(x, host.position.y, z);
      state.propPlan = "around";
      return true;
    }
  }
  return false;
}

/** How far (cx, cz) is from the segment a–b. */
function segmentNear(
  cx: number,
  cz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t =
    len2 > 1e-9
      ? MathUtils.clamp(((cx - ax) * dx + (cz - az) * dz) / len2, 0, 1)
      : 0;
  return Math.hypot(ax + dx * t - cx, az + dz * t - cz);
}

/** Off the prop and done with it (put somewhere else entirely). */
function leaveProp(state: CatState) {
  state.perched = false;
  state.hop = -1;
  state.propPlan = "none";
}

/** Sat up on the prop already (back from a long gap: it'd have got up
 * there meanwhile). */
function perchOn(state: CatState, host: CatHost) {
  const p = host.prop;
  if (!p) return;
  if (
    Math.hypot(p.x - host.position.x, p.z - host.position.z) >
    PROP_REACH * host.scale
  )
    return;
  state.position.set(p.x, p.top, p.z);
  state.perched = true;
  state.hop = -1;
  state.propPlan = "on";
  state.sideOn = true;
  state.sideTried = true;
  state.sideGoal.set(p.x, host.position.y, p.z);
  state.following = false;
}

/** Starts a hop: up onto the prop's top, or down off it to `x`, `z`. */
function startHop(
  state: CatState,
  host: CatHost,
  up: boolean,
  x: number,
  z: number,
) {
  state.hop = 0;
  state.hopUp = up;
  state.hopFrom.copy(state.position);
  state.hopTo.set(x, up && host.prop ? host.prop.top : groundAt(host, x, z), z);
  state.heading = Math.atan2(x - state.position.x, z - state.position.z);
  state.speed = state.speedVelocity = 0;
  state.perched = false;
}

/** Footstep `i` (counted from 0, still in the ring). */
function trailX(state: CatState, i: number) {
  return state.trail[(i % TRAIL_CAP) * 2];
}
function trailZ(state: CatState, i: number) {
  return state.trail[(i % TRAIL_CAP) * 2 + 1];
}

/** The oldest footstep still kept. */
function trailOldest(state: CatState) {
  return Math.max(0, state.trailHead - TRAIL_CAP);
}

/** Starts the trail afresh where the herzie stands. */
function resetTrail(state: CatState, host: CatHost) {
  state.trailHead = 0;
  state.trailNext = 0;
  pushStep(state, host.position.x, host.position.z);
}

function pushStep(state: CatState, x: number, z: number) {
  const at = (state.trailHead % TRAIL_CAP) * 2;
  state.trail[at] = x;
  state.trail[at + 1] = z;
  state.trailHead++;
}

/** Leaves a footstep where the herzie is, if it's come far enough. */
function stepTrail(state: CatState, host: CatHost) {
  if (state.trailHead === 0) {
    resetTrail(state, host);
    return;
  }
  const last = state.trailHead - 1;
  if (
    Math.hypot(
      host.position.x - trailX(state, last),
      host.position.z - trailZ(state, last),
    ) >=
    TRAIL_SPACING * host.scale
  )
    pushStep(state, host.position.x, host.position.z);
}

/** Moves on to the next footstep once it's reached this one, or cuts a
 * corner where the way ahead is clear. */
function advanceTrail(state: CatState, host: CatHost) {
  const k = host.scale;
  const { x, z } = state.position;
  state.trailNext = Math.max(state.trailNext, trailOldest(state));
  while (
    state.trailNext < state.trailHead &&
    Math.hypot(
      trailX(state, state.trailNext) - x,
      trailZ(state, state.trailNext) - z,
    ) <
      TRAIL_REACH * k
  )
    state.trailNext++;
  const ahead = Math.min(state.trailNext + TRAIL_SHORTCUT, state.trailHead - 1);
  if (
    ahead > state.trailNext &&
    pathClear(host, x, z, trailX(state, ahead), trailZ(state, ahead))
  )
    state.trailNext = ahead;
}

/** How far it has to walk along the herzie's footsteps to the herzie. */
function pathLeft(state: CatState, host: CatHost): number {
  let px = state.position.x;
  let pz = state.position.z;
  let d = 0;
  for (let i = state.trailNext; i < state.trailHead; i++) {
    const x = trailX(state, i);
    const z = trailZ(state, i);
    d += Math.hypot(x - px, z - pz);
    px = x;
    pz = z;
  }
  return d + Math.hypot(host.position.x - px, host.position.z - pz);
}

/** Back in from out of sight: a way back along the herzie's own path (it
 * walked there, so the way's open), trotting in. False with too little
 * path to go on. */
function respawnOnTrail(state: CatState, host: CatHost): boolean {
  const oldest = trailOldest(state);
  if (state.trailHead - oldest < 3) return false;
  const want = RESPAWN_TRAIL * host.scale;
  let i = state.trailHead - 1;
  let d = Math.hypot(
    host.position.x - trailX(state, i),
    host.position.z - trailZ(state, i),
  );
  while (i > oldest && d < want) {
    d += Math.hypot(
      trailX(state, i) - trailX(state, i - 1),
      trailZ(state, i) - trailZ(state, i - 1),
    );
    i--;
  }
  const x = trailX(state, i);
  const z = trailZ(state, i);
  state.position.set(x, groundAt(host, x, z), z);
  state.trailNext = i + 1;
  const nx =
    state.trailNext < state.trailHead ? trailX(state, i + 1) : host.position.x;
  const nz =
    state.trailNext < state.trailHead ? trailZ(state, i + 1) : host.position.z;
  state.heading = Math.atan2(nx - x, nz - z);
  return true;
}

/** Puts it on its spot, at rest (a first sighting, a long hidden frame). */
function snapToSlot(state: CatState, host: CatHost) {
  state.slotHeading = host.heading;
  state.hostVelocity.set(0, 0, 0);
  slotAt(state, host, host.heading);
  state.position.set(slot.x, groundAt(host, slot.x, slot.z), slot.z);
  if (!walkable(host, slot.x, slot.z)) {
    // No room there: behind the herzie instead.
    const back = (host.clearance + BEHIND_GAP) * host.scale;
    const x = host.position.x - Math.sin(host.heading) * back;
    const z = host.position.z - Math.cos(host.heading) * back;
    state.position.set(x, groundAt(host, x, z), z);
  }
  state.hostLast.copy(host.position);
  state.heading = host.heading;
  state.speed = state.speedVelocity = 0;
  state.following = false;
  state.react = -1;
  state.turnRate = 0;
  state.groundVelocity = 0;
  state.started = true;
  state.sideOn = false;
  state.sideTried = true;
  leaveProp(state);
  state.lieDown = false;
  state.homeStart = false;
  state.homeRush = false;
  resetTrail(state, host);
}

/** Puts it out of sight behind the herzie, trotting in. */
function respawn(state: CatState, host: CatHost) {
  const k = host.scale;
  state.speed = TROT_PACE * k;
  state.speedVelocity = 0;
  state.rest = state.restVelocity = state.restTarget = 0;
  state.stretch = state.yawn = state.groom = -1;
  state.following = true;
  state.react = -1;
  state.groundVelocity = 0;
  state.sideOn = false;
  leaveProp(state);
  state.stuckFor = 0;
  state.stuckBest = Number.POSITIVE_INFINITY;
  if (respawnOnTrail(state, host)) return;
  resetTrail(state, host);
  const side = state.random() < 0.5 ? -1 : 1;
  // Behind and to one side, else round the other way, else nearer; on dry
  // land, or (nowhere dry) where the herzie stands.
  state.position.set(
    host.position.x,
    groundAt(host, host.position.x, host.position.z),
    host.position.z,
  );
  search: for (const sign of [side, -side]) {
    for (let i = 0; i < 8; i++) {
      const a = host.heading + sign * (RESPAWN_ANGLE - i * 0.25);
      const d = RESPAWN_DISTANCE * k * (1 - i * 0.07);
      const x = host.position.x + Math.sin(a) * d;
      const z = host.position.z + Math.cos(a) * d;
      if (walkable(host, x, z)) {
        state.position.set(x, groundAt(host, x, z), z);
        break search;
      }
    }
  }
  state.heading = Math.atan2(
    host.position.x - state.position.x,
    host.position.z - state.position.z,
  );
  state.speed = TROT_PACE * k;
  state.speedVelocity = 0;
  state.rest = state.restVelocity = state.restTarget = 0;
  state.stretch = state.yawn = state.groom = -1;
  state.following = true;
  state.react = -1;
  state.groundVelocity = 0;
}

/** What it should be doing at rest, given how long the herzie's been still. */
function restFor(state: CatState, host: CatHost): number {
  if (state.fetch !== "none") return REST_STAND;
  // Lying beside the herzie, Home's way (asleep, if its player's away).
  if (state.lieDown) return host.afk ? REST_SLEEP : REST_LIE;
  if (host.dancing) return REST_SIT;
  if (host.afk || state.still > SLEEP_AFTER) return REST_SLEEP;
  if (host.sitting && state.still > BENCH_LIE_AFTER) return REST_LIE;
  if (state.still > LIE_AFTER) return REST_LIE;
  if (state.still > SIT_AFTER) return REST_SIT;
  return REST_STAND;
}

/** Steps it moves, round water: straight on, or the nearest way off its
 * heading that's dry. Returns the heading it can take, or NaN if none. */
function dryHeading(
  state: CatState,
  host: CatHost,
  heading: number,
  step: number,
): number {
  const { x, z } = state.position;
  // Look a little further ahead than one frame's step, so it turns before
  // the edge rather than at it.
  const reach = Math.max(step, 0.35 * host.scale);
  for (let i = 0; i < 7; i++) {
    const off = i === 0 ? 0 : Math.ceil(i / 2) * 0.5 * (i % 2 ? 1 : -1);
    const a = heading + off;
    if (walkable(host, x + Math.sin(a) * reach, z + Math.cos(a) * reach))
      return a;
  }
  return Number.NaN;
}

const goal = new Vector3();

/**
 * The herzie's gone Home: the cat's up at once and hurries the quickest
 * way up on its prop (`prop`: it has one, if only just setting out) or,
 * without one, down beside it. The same every time, wherever it was.
 */
export function catToHome(state: CatState, prop: boolean): void {
  if (!state.started) return;
  state.homeStart = true;
  state.homeProp = prop;
}

/** Off to the herzie's side (Home, no prop), to lie down there facing the
 * camera: on a side with room. */
function lieBeside(state: CatState, host: CatHost): boolean {
  const k = host.scale;
  const f = host.facing ?? host.heading;
  const hx = host.position.x;
  const hz = host.position.z;
  const out = (host.clearance + BODY_RADIUS + 0.2) * k;
  // The cat's side first.
  const toCat = Math.atan2(state.position.x - hx, state.position.z - hz);
  const sides = [f + Math.PI / 2, f - Math.PI / 2].sort(
    (u, v) => Math.abs(angleDelta(toCat, u)) - Math.abs(angleDelta(toCat, v)),
  );
  for (const a of sides) {
    const x = hx + Math.sin(a) * out;
    const z = hz + Math.cos(a) * out;
    if (
      walkable(host, x, z) &&
      pathClear(host, state.position.x, state.position.z, x, z) &&
      segmentNear(hx, hz, state.position.x, state.position.z, x, z) >=
        host.clearance * k
    ) {
      state.sideGoal.set(x, host.position.y, z);
      state.sideOn = true;
      state.lieDown = true;
      state.following = true;
      return true;
    }
  }
  return false;
}

/**
 * Moves the cat on by `dt` seconds after its herzie, whose ground speed is
 * `speed`. A first step, or a long frame, puts it on its spot; a step of 0
 * leaves it be.
 */
export function stepCat(
  state: CatState,
  host: CatHost,
  speed: number,
  dt: number,
): void {
  if (
    state.started &&
    dt > MAX_DT &&
    Math.hypot(
      host.position.x - state.hostLast.x,
      host.position.z - state.hostLast.z,
    ) <
      0.5 * host.scale
  ) {
    // A long gap (the window shut, a stall) with the herzie where it was:
    // nothing's changed meanwhile. Carries on from here.
    return;
  }
  if (!state.started || dt > MAX_DT) {
    snapToSlot(state, host);
    // Its herzie standing at its prop: up on it, as it would be by now.
    if (host.prop && speed <= 0.3) perchOn(state, host);
    return;
  }
  if (dt <= 0) return;
  const k = host.scale;
  state.clock += dt;

  // Gone Home: up at once, and off.
  if (state.homeStart) {
    state.homeStart = false;
    state.homeRush = true;
    leaveProp(state);
    state.lieDown = false;
    state.propTries = 0;
    state.propGaveUp = false;
    state.propIn = 0;
    state.sideTried = true;
    state.stretch = state.yawn = state.groom = -1;
    state.react = -1;
    state.stuckFor = 0;
    state.stuckBest = Number.POSITIVE_INFINITY;
    if (!state.homeProp && !lieBeside(state, host)) state.homeRush = false;
  }

  // The herzie's velocity, from where it's been (a teleport resets it).
  {
    const dx = host.position.x - state.hostLast.x;
    const dz = host.position.z - state.hostLast.z;
    state.hostLast.copy(host.position);
    if (Math.hypot(dx, dz) > 3 * k) {
      state.hostVelocity.set(0, 0, 0);
      // A jump across the map: no path from there to here.
      resetTrail(state, host);
    } else {
      const t = 1 - Math.exp(-8 * dt);
      state.hostVelocity.x += (dx / dt - state.hostVelocity.x) * t;
      state.hostVelocity.z += (dz / dt - state.hostVelocity.z) * t;
    }
  }
  const hostMoving = speed > 0.3;
  state.still = hostMoving ? 0 : state.still + dt;
  // The herzie setting off: that gets its attention.
  if (hostMoving && !state.hostWasMoving) state.watchFor = WATCH_SETTING_OFF;
  state.hostWasMoving = hostMoving;
  // How much of a hurry it's in: none for a stroll, all of it for a sprint.
  const hostPace = Math.max(
    speed,
    Math.hypot(state.hostVelocity.x, state.hostVelocity.z),
  );
  // Hurrying Home: all of it.
  const urgency = state.homeRush
    ? 1
    : MathUtils.smoothstep(hostPace / k, WALK_SPEED * 0.5, SPRINT_SPEED);
  stepTrail(state, host);

  // Far away (a teleport, a portal): back in from out of sight.
  const fromHost = Math.hypot(
    state.position.x - host.position.x,
    state.position.z - host.position.z,
  );
  if (fromHost > SNAP_DISTANCE * k && state.fetch === "none") {
    respawn(state, host);
  }

  // Fetching: what it's after, and what it does about it.
  if (state.target) {
    if (state.fetch === "none" || state.fetch === "returning") {
      state.fetch = "going";
      state.following = true;
      state.react = -1;
    } else if (
      state.fetch === "holding" &&
      Math.hypot(
        state.target.x - state.pounceTo.x,
        state.target.z - state.pounceTo.z,
      ) >
        POUNCE_REACH * k * 1.5
    ) {
      // Sent somewhere new.
      state.fetch = "going";
    }
  } else if (
    state.fetch === "going" ||
    state.fetch === "pounce" ||
    state.fetch === "holding"
  ) {
    state.fetch = "returning";
    state.following = true;
  }

  state.slotHeading = turnToward(
    state.slotHeading,
    host.heading,
    SLOT_TURN_RATE,
    Number.POSITIVE_INFINITY,
    dt,
  );

  // Where it's going: after something it's fetching; up beside the herzie
  // when it's stopped and there's room; else along the herzie's footsteps,
  // to its gap behind.
  if (hostMoving || state.fetch !== "none") {
    if (state.sideOn) {
      // Off the side and back in behind: only footsteps from here on.
      state.trailNext = state.trailHead;
    }
    state.sideOn = false;
    state.sideTried = false;
    state.propPlan = "none";
    state.propTries = 0;
    state.propGaveUp = false;
    state.lieDown = false;
    state.homeRush = false;
  }
  if (state.fetch === "returning") state.trailNext = state.trailHead;
  if (
    !state.sideTried &&
    !hostMoving &&
    !state.following &&
    state.fetch === "none" &&
    state.still > SIDE_AFTER &&
    state.rest < 0.5
  ) {
    state.sideTried = true;
    state.propPlan = "none";
    state.propTries = 0;
    state.sideOn = pickProp(state, host) || pickSide(state, host);
    if (state.sideOn) state.following = true;
  }
  // Down beside the herzie (Home, no prop): there; no more hurry.
  if (state.homeRush && state.lieDown && !state.following)
    state.homeRush = false;
  // The herzie stopped by its prop (Home's boombox): that's where it
  // wants to be. Looks for a way up now and then till it's there (or it's
  // tried enough this stop) — the prop may only just have set out, or the
  // cat been on its way somewhere else.
  if (
    host.prop &&
    !hostMoving &&
    state.fetch === "none" &&
    state.hop < 0 &&
    !state.perched &&
    (state.propPlan === "none" ||
      // Round the herzie: from there, on to the prop.
      (state.propPlan === "around" && !state.following)) &&
    !state.propGaveUp
  ) {
    if (state.propPlan === "around") {
      state.propPlan = "none";
      state.propIn = 0;
    }
    state.propIn -= dt;
    if (state.propIn <= 0) {
      state.propIn = state.homeRush ? 0.25 : 1;
      if (pickProp(state, host, null, state.homeRush)) {
        state.sideOn = true;
        state.sideTried = true;
        state.following = true;
      } else if (++state.propTries > PROP_RETRIES) {
        state.propGaveUp = true;
        state.homeRush = false;
      }
    }
  }
  let away: number;
  let stopAt: number;
  if (state.target) {
    goal.copy(state.target);
    away = Math.hypot(goal.x - state.position.x, goal.z - state.position.z);
    stopAt = POUNCE_REACH * k;
  } else if (state.sideOn) {
    goal.copy(state.sideGoal);
    away = Math.hypot(goal.x - state.position.x, goal.z - state.position.z);
    stopAt = 0.12 * k;
  } else {
    advanceTrail(state, host);
    if (state.trailNext < state.trailHead) {
      goal.set(
        trailX(state, state.trailNext),
        host.position.y,
        trailZ(state, state.trailNext),
      );
    } else goal.copy(host.position);
    away = pathLeft(state, host);
    stopAt = (host.clearance + BEHIND_GAP) * k;
  }
  const gx = goal.x - state.position.x;
  const gz = goal.z - state.position.z;

  if (state.fetch === "returning" && away < stopAt + RETURNED_RADIUS * k) {
    state.fetch = "none";
  }

  // Getting up to follow, or settling: with hysteresis and a beat of
  // reaction (and a stretch first, from lying down).
  const fetching = state.fetch !== "none";
  const wasFollowing = state.following;
  if (!state.following) {
    // In a hurry, it's up as soon as the herzie's off.
    const slack = MathUtils.lerp(TRAIL_SLACK, 0.25, urgency);
    if (away > stopAt + slack * k || fetching) {
      if (state.react < 0) {
        state.react = fetching
          ? 0.1
          : MathUtils.lerp(
              REACT_MIN + state.random() * (REACT_MAX - REACT_MIN),
              0.05,
              urgency,
            );
        // A stretch only for an unhurried start.
        if (
          state.rest > 1.5 &&
          state.stretch < 0 &&
          !fetching &&
          urgency < 0.5
        ) {
          state.stretch = 0;
          state.react = Math.max(state.react, STRETCH_SECONDS * 0.8);
          if (state.rest > 2.5) state.yawn = 0;
        }
      }
      state.react -= dt;
      if (state.react <= 0) {
        state.following = true;
        state.react = -1;
      }
    } else state.react = -1;
  } else if (
    !fetching &&
    away < stopAt + 0.1 * k &&
    (state.sideOn ||
      Math.hypot(state.hostVelocity.x, state.hostVelocity.z) < 0.6 * k)
  ) {
    state.following = false;
  }

  // Getting nowhere: off the side and back behind; or, well behind,
  // back in along the herzie's path.
  if (state.following && !wasFollowing) {
    state.stuckFor = 0;
    state.stuckBest = away;
  }
  if (state.following && state.fetch === "none" && state.rest < 0.35) {
    if (away < state.stuckBest - STUCK_PROGRESS * k) {
      state.stuckBest = away;
      state.stuckFor = 0;
    } else state.stuckFor += dt;
    if (state.stuckFor > STUCK_SECONDS) {
      state.stuckFor = 0;
      state.stuckBest = Number.POSITIVE_INFINITY;
      if (
        state.sideOn &&
        state.propPlan !== "none" &&
        state.propTries < PROP_RETRIES &&
        pickProp(state, host, goal)
      ) {
        // Somewhere else round it.
        state.propTries++;
      } else if (state.sideOn) {
        if (state.propPlan !== "none") state.propGaveUp = true;
        state.sideOn = false;
        state.following = false;
        state.propPlan = "none";
      } else if (away > stopAt + 2 * k) respawn(state, host);
    }
  } else state.stuckFor = 0;

  // Resting: eased up and down between levels.
  state.restTarget =
    state.following || state.react >= 0 || state.stretch >= 0
      ? REST_STAND
      : restFor(state, host);
  {
    const up = state.restTarget < state.rest;
    state.rest = springTo(
      state.rest,
      state.restVelocity,
      state.restTarget,
      up ? REST_UP_FREQUENCY * (1 + 1.8 * urgency) : REST_DOWN_FREQUENCY,
      1,
      dt,
    );
    state.restVelocity = springVelocity;
    if (Math.abs(state.rest - state.restTarget) < 1e-4) state.restVelocity = 0;
  }
  if (state.stretch >= 0) {
    state.stretch += dt;
    if (state.stretch > STRETCH_SECONDS) state.stretch = -1;
  }
  if (state.yawn >= 0) {
    state.yawn += dt;
    if (state.yawn > YAWN_SECONDS) state.yawn = -1;
  }

  // How fast it wants to go, and which way.
  const want = Math.atan2(gx, gz);
  const off = angleDelta(state.heading, want);
  // Not until it's up (and done stretching); in a hurry, it's off while
  // still scrambling up.
  const up =
    state.rest < MathUtils.lerp(0.35, 0.75, urgency) && state.stretch < 0;
  let desired = 0;
  if (state.fetch === "pounce" || state.fetch === "holding") desired = 0;
  else if (state.following && up) {
    const gap = Math.max(0, away - stopAt);
    // Keeping pace with the herzie, along its path (or not, off to the side
    // or after something).
    const along =
      state.sideOn || fetching
        ? 0
        : Math.hypot(state.hostVelocity.x, state.hostVelocity.z);
    // Hurrying Home: off at a dash, all the way.
    const homeRun = state.homeRush;
    const top = Math.max(
      (away - stopAt > LEASH * k || fetching || homeRun
        ? DASH_PACE
        : TROT_PACE) * k,
      // Never left behind by a sprint.
      along * OUTPACE,
    );
    desired = MathUtils.clamp(along + ARRIVE_GAIN * gap, 0, top);
    // An easy amble when it's only a little way off.
    if (!hostMoving && !fetching && !homeRun && gap < START_RADIUS * 1.2 * k)
      desired = Math.min(desired, WALK_PACE * k);
    // Slow into a turn; turn on the spot when it's well off and slow.
    desired *= MathUtils.clamp(Math.cos(off) * 0.75 + 0.35, 0, 1);
    if (Math.abs(off) > TURN_IN_PLACE && state.speed < TROT_FROM * k)
      desired = 0;
  }
  state.speed = springTo(
    state.speed,
    state.speedVelocity,
    desired,
    desired < state.speed ? BRAKE_FREQUENCY : SPEED_FREQUENCY * (1 + urgency),
    1,
    dt,
  );
  state.speedVelocity = springVelocity;
  if (state.speed < 1e-3 && desired === 0)
    state.speed = state.speedVelocity = 0;

  // Turning: arcs at speed, pivots when still.
  const before = state.heading;
  let face = state.heading;
  if (state.perched && host.prop?.facing !== undefined && state.hop < 0)
    // Up on it: facing the camera.
    face = host.prop.facing;
  else if (
    state.lieDown &&
    !state.following &&
    host.facing !== undefined &&
    host.facing !== null
  )
    // Lying beside the herzie at Home: facing the camera too.
    face = host.facing;
  else if (state.following && up && state.fetch !== "holding") face = want;
  else if (
    state.propPlan === "beside" &&
    host.prop &&
    !state.following &&
    state.fetch === "none"
  ) {
    // Settling beside the prop: alongside it, not backed into it.
    const toProp = Math.atan2(
      host.prop.x - state.position.x,
      host.prop.z - state.position.z,
    );
    const a = toProp + Math.PI / 2;
    const b = toProp - Math.PI / 2;
    face =
      Math.abs(angleDelta(state.heading, a)) <
      Math.abs(angleDelta(state.heading, b))
        ? a
        : b;
  } else if (state.rest < 0.5 && state.fetch === "none") {
    // Standing about: turn to keep the herzie in view if it's well behind.
    const toHost = Math.atan2(
      host.position.x - state.position.x,
      host.position.z - state.position.z,
    );
    if (Math.abs(angleDelta(state.heading, toHost)) > 1.9) face = toHost;
  }
  const most = MathUtils.lerp(
    TURN_STILL,
    TURN_FAST,
    MathUtils.clamp(state.speed / (TROT_PACE * k), 0, 1),
  );
  state.heading = turnToward(state.heading, face, TURN_RATE, most, dt);
  const turned = angleDelta(before, state.heading);
  state.turnRate = MathUtils.damp(state.turnRate, turned / dt, 10, dt);

  // Up on the prop: down again once it's up to go (or at once, the prop
  // gone); at the spot it meant to jump from, up.
  if (state.perched && state.hop < 0) {
    const p = host.prop;
    if (!p) state.perched = false;
    else if (state.following && up) {
      const dx = host.position.x - p.x;
      const dz = host.position.z - p.z;
      const d = Math.max(1e-6, Math.hypot(dx, dz));
      const out = p.r + PROP_TAKEOFF * k;
      startHop(state, host, false, p.x + (dx / d) * out, p.z + (dz / d) * out);
      state.propPlan = "none";
      state.sideOn = false;
    }
  } else if (
    state.hop < 0 &&
    state.propPlan === "on" &&
    state.sideOn &&
    host.prop &&
    !state.following &&
    state.fetch === "none"
  ) {
    startHop(state, host, true, host.prop.x, host.prop.z);
    state.sideGoal.set(host.prop.x, host.position.y, host.prop.z);
  }

  // Moving: forward along its heading, round water, and never through the
  // herzie.
  let moved = 0;
  if (state.hop >= 0) {
    // Hopping: a crouch, then up (or down) in an arc, then a landing.
    state.hop += dt;
    const t = state.hop / HOP_SECONDS;
    const u = MathUtils.smoothstep(t, POUNCE_LEAP, POUNCE_LAND);
    const nx = MathUtils.lerp(state.hopFrom.x, state.hopTo.x, u);
    const nz = MathUtils.lerp(state.hopFrom.z, state.hopTo.z, u);
    moved = Math.hypot(nx - state.position.x, nz - state.position.z);
    state.position.set(
      nx,
      MathUtils.lerp(state.hopFrom.y, state.hopTo.y, u),
      nz,
    );
    if (t >= 1) {
      state.hop = -1;
      state.perched = state.hopUp && !!host.prop;
      state.propTries = 0;
      if (state.perched) state.homeRush = false;
    }
  } else if (state.perched) {
    // Sat on it: going nowhere.
    state.speed = state.speedVelocity = 0;
  } else if (state.fetch === "pounce") {
    state.pounce += dt;
    const t = state.pounce / POUNCE_SECONDS;
    if (t >= POUNCE_LEAP) {
      const u = MathUtils.smoothstep(t, POUNCE_LEAP, POUNCE_LAND);
      const nx = MathUtils.lerp(state.pounceFrom.x, state.pounceTo.x, u);
      const nz = MathUtils.lerp(state.pounceFrom.z, state.pounceTo.z, u);
      moved = Math.hypot(nx - state.position.x, nz - state.position.z);
      state.position.x = nx;
      state.position.z = nz;
    }
    if (t >= 1) state.fetch = "holding";
  } else if (state.speed > 0) {
    // Never past where it means to stop (a sudden stop ahead of it).
    const step = Math.min(
      state.speed * dt,
      state.fetch === "going"
        ? Number.POSITIVE_INFINITY
        : Math.max(0, away - stopAt),
    );
    if (step < state.speed * dt) {
      state.speed = step / dt;
      state.speedVelocity = 0;
    }
    const dry = dryHeading(state, host, state.heading, step);
    if (Number.isNaN(dry)) {
      state.speed = state.speedVelocity = 0;
    } else {
      if (dry !== state.heading)
        state.heading = turnToward(
          state.heading,
          dry,
          TURN_RATE * 2,
          most * 2,
          dt,
        );
      state.position.x += Math.sin(dry) * step;
      state.position.z += Math.cos(dry) * step;
      moved = step;
    }
  }
  {
    const ox = state.position.x - host.position.x;
    const oz = state.position.z - host.position.z;
    const r = Math.hypot(ox, oz);
    const clear = host.clearance * k;
    if (r < clear) {
      // Dead centre (it can't be, really): out behind.
      const ux = r > 1e-6 ? ox / r : -Math.sin(host.heading);
      const uz = r > 1e-6 ? oz / r : -Math.cos(host.heading);
      state.position.x = host.position.x + ux * clear;
      state.position.z = host.position.z + uz * clear;
    }
  }
  // Beside the prop and turned alongside it: shuffles in against it as it
  // settles.
  if (
    state.propPlan === "beside" &&
    host.prop &&
    !state.following &&
    state.fetch === "none" &&
    state.hop < 0 &&
    state.rest < 1.2
  ) {
    const p = host.prop;
    const ox = state.position.x - p.x;
    const oz = state.position.z - p.z;
    const d = Math.hypot(ox, oz);
    const snug = p.r + (BODY_RADIUS + PROP_SNUG) * k;
    const radial = Math.atan2(-ox, -oz);
    const alongside =
      Math.abs(Math.abs(angleDelta(state.heading, radial)) - Math.PI / 2) <
      0.35;
    if (alongside && d > snug + 1e-3) {
      const step = Math.min(d - snug, SNUG_PACE * k * dt);
      state.position.x -= (ox / d) * step;
      state.position.z -= (oz / d) * step;
    }
  }

  // Nor through the prop (it may have just appeared where it stands) —
  // any of it, nose to rump.
  if (host.prop && !state.perched && state.hop < 0) {
    keepOffProp(state, host);
  }

  // Close enough to pounce.
  if (state.fetch === "going" && state.target && state.rest < 0.35) {
    const dx = state.target.x - state.position.x;
    const dz = state.target.z - state.position.z;
    const d = Math.hypot(dx, dz);
    if (d < POUNCE_REACH * k * 1.25 && state.speed < TROT_PACE * k) {
      state.fetch = "pounce";
      state.pounce = 0;
      state.pounceFrom.copy(state.position);
      // Lands with its nose on it.
      const reach = CAT_LENGTH * 0.5 * k;
      const ux = d > 1e-6 ? dx / d : Math.sin(state.heading);
      const uz = d > 1e-6 ? dz / d : Math.cos(state.heading);
      state.pounceTo.set(
        state.target.x - ux * reach,
        0,
        state.target.z - uz * reach,
      );
      if (d < reach) state.pounceTo.copy(state.position);
      state.heading = turnToward(state.heading, Math.atan2(dx, dz), 30, 30, dt);
      state.speed = state.speedVelocity = 0;
    }
  }

  // Hopping, it's where the hop has it; up on the prop, on its flat top.
  if (state.hop >= 0 || (state.perched && host.prop)) {
    if (state.perched && host.prop) state.position.y = host.prop.top;
    state.groundVelocity = 0;
    state.slopePitch = MathUtils.damp(state.slopePitch, 0, 8, dt);
    state.slopeRoll = MathUtils.damp(state.slopeRoll, 0, 8, dt);
  } else {
    // Standing on the ground, tilted to it.
    const { x, z } = state.position;
    const h = groundAt(host, x, z);
    state.position.y = springTo(
      state.position.y,
      state.groundVelocity,
      h,
      6,
      1,
      dt,
    );
    state.groundVelocity = springVelocity;
    const half = CAT_LENGTH * 0.45 * k;
    const fs = Math.sin(state.heading);
    const fc = Math.cos(state.heading);
    const front = groundAt(host, x + fs * half, z + fc * half);
    const back = groundAt(host, x - fs * half, z - fc * half);
    const w = 0.2 * k;
    // Its right, facing (sin, cos) with y up: (−cos, sin).
    const right = groundAt(host, x - fc * w, z + fs * w);
    const left = groundAt(host, x + fc * w, z - fs * w);
    state.slopePitch = MathUtils.damp(
      state.slopePitch,
      Math.atan2(front - back, half * 2),
      8,
      dt,
    );
    state.slopeRoll = MathUtils.damp(
      state.slopeRoll,
      Math.atan2(right - left, w * 2) * 0.6,
      8,
      dt,
    );
  }

  // Its gait: by the ground it covers (and its steps turning on the spot).
  {
    const trotting = MathUtils.smoothstep(
      state.speed / k,
      TROT_FROM,
      TROT_FULL,
    );
    state.trot = MathUtils.damp(state.trot, trotting, 5, dt);
    const stride = MathUtils.lerp(STRIDE_WALK, STRIDE_TROT, state.trot) * k;
    const pivot = state.speed < 0.3 * k ? Math.abs(turned) * TURN_STEPS : 0;
    state.phase = (state.phase + moved / stride + pivot) % 1;
    const walking = Math.max(
      MathUtils.clamp(state.speed / (0.5 * k), 0, 1),
      MathUtils.clamp(Math.abs(state.turnRate) / 2.5, 0, 0.7),
    );
    state.moving = MathUtils.damp(state.moving, walking, 9, dt);
    state.lean = MathUtils.damp(
      state.lean,
      MathUtils.clamp(state.turnRate * (state.speed / k) * 0.035, -0.3, 0.3),
      6,
      dt,
    );
  }

  stepLife(state, host, dt);
  stepHead(state, host, dt);
  stepTail(state, host, dt);
}

/** Blinks, twitches, flicks, glances and grooming: the little things. */
function stepLife(state: CatState, host: CatHost, dt: number) {
  const r = state.random;
  const awake = state.rest < 2.5;
  // Blinks.
  if (state.blink >= 0) {
    state.blink += dt;
    if (state.blink > BLINK_SECONDS) state.blink = -1;
  } else if (awake) {
    state.blinkIn -= dt;
    if (state.blinkIn <= 0) {
      state.blink = 0;
      // Now and then a double blink: slow and content.
      state.blinkIn = r() < 0.2 ? 0.3 : 2 + r() * 4.5;
    }
  }
  // An ear twitch.
  if (state.twitch >= 0) {
    state.twitch += dt;
    if (state.twitch > TWITCH_SECONDS) state.twitch = -1;
  } else {
    state.twitchIn -= dt;
    if (state.twitchIn <= 0) {
      state.twitch = 0;
      state.twitchEar = r() < 0.5 ? -1 : 1;
      // At the boombox with the music on: twitching along to it.
      const listening =
        host.dancing && (state.perched || state.propPlan !== "none");
      state.twitchIn = listening ? 0.35 + r() * 0.9 : 2.5 + r() * 7;
    }
  }
  // A flick of the tail's tip.
  if (state.flick >= 0) {
    state.flick += dt;
    if (state.flick > FLICK_SECONDS) state.flick = -1;
  } else if (state.moving < 0.5) {
    state.flickIn -= dt;
    if (state.flickIn <= 0) {
      state.flick = 0;
      state.flickIn = (state.rest > 2.5 ? 6 : 2) + r() * 5;
    }
  }
  // Grooming a paw: only sitting, settled, and now and then.
  const settledSit =
    Math.abs(state.rest - REST_SIT) < 0.08 && state.restTarget === REST_SIT;
  if (state.groom >= 0) {
    state.groom += dt;
    if (state.groom > GROOM_SECONDS || !settledSit) state.groom = -1;
  } else if (settledSit && !host.dancing) {
    state.groomIn -= dt;
    if (state.groomIn <= 0) {
      state.groom = 0;
      state.groomIn = 8 + r() * 10;
    }
  }
  // A yawn, settled down, now and then.
  if (state.yawn < 0 && state.rest > 0.9 && state.rest < 2.5 && !host.dancing) {
    if (r() < dt / 35) state.yawn = 0;
  }
  // Now and then it looks over at the herzie, for a while.
  if (state.watchFor > 0) state.watchFor -= dt;
  else {
    state.watchIn -= dt;
    if (state.watchIn <= 0) {
      state.watchFor =
        WATCH_SECONDS[0] + r() * (WATCH_SECONDS[1] - WATCH_SECONDS[0]);
      state.watchIn = WATCH_EVERY[0] + r() * (WATCH_EVERY[1] - WATCH_EVERY[0]);
    }
  }
  // Glances about while it isn't going anywhere.
  if (state.glanceFor > 0) state.glanceFor -= dt;
  else {
    state.glanceIn -= dt;
    if (state.glanceIn <= 0) {
      state.glanceYaw = (r() * 2 - 1) * 1.1;
      state.glanceFor = 1.2 + r() * 1.8;
      state.glanceIn = 3 + r() * 5;
    }
  }
}

const look = new Vector3();

/** Where it looks: the head turns after its ears. */
function stepHead(state: CatState, host: CatHost, dt: number) {
  const k = host.scale;
  let yaw = 0;
  let pitch = 0;
  const sleeping = state.rest > 2.5;
  if (state.fetch === "pounce" || state.fetch === "holding") {
    // Down at what it's caught.
    pitch = -0.6;
  } else if (state.target && state.fetch === "going") {
    look.copy(state.target);
    yaw = angleDelta(
      state.heading,
      Math.atan2(look.x - state.position.x, look.z - state.position.z),
    );
    pitch = -0.25;
  } else if (state.moving > 0.4) {
    // Into the turn, a little ahead of the body.
    yaw = state.turnRate * 0.18;
    pitch = state.trot * -0.05;
  } else if (!sleeping) {
    const near =
      state.glanceAt &&
      Math.hypot(
        state.glanceAt.x - state.position.x,
        state.glanceAt.z - state.position.z,
      ) <
        6 * k;
    const prop =
      state.propPlan === "beside" && !state.following ? host.prop : null;
    // Something nearby to look at; else the herzie, when it's watching it;
    // else the prop it's settled against; else about it, of its own accord.
    const watching = state.watchFor > 0;
    let at = true;
    if (near && state.glanceAt) look.copy(state.glanceAt);
    else if (watching)
      look.set(host.position.x, host.position.y + 1.6 * k, host.position.z);
    else if (prop) look.set(prop.x, prop.top, prop.z);
    else at = false;
    if (at) {
      const dx = look.x - state.position.x;
      const dz = look.z - state.position.z;
      yaw = angleDelta(state.heading, Math.atan2(dx, dz));
      pitch = Math.atan2(
        look.y - (state.position.y + 0.5 * k),
        Math.hypot(dx, dz),
      );
    } else {
      // Straight ahead, glancing about now and then.
      yaw = state.glanceFor > 0 ? state.glanceYaw : 0;
      pitch = 0;
    }
    if (host.dancing) yaw += Math.sin(state.clock * Math.PI * 2 * 0.9) * 0.3;
  }
  yaw = MathUtils.clamp(yaw, -1.3, 1.3);
  pitch = MathUtils.clamp(pitch, -0.7, 0.6);
  // Ears first, quick; the head after, softer.
  state.earYaw = springTo(state.earYaw, state.earYawVelocity, yaw, 4, 0.7, dt);
  state.earYawVelocity = springVelocity;
  state.headYaw = springTo(
    state.headYaw,
    state.headYawVelocity,
    state.earYaw,
    1.8,
    0.85,
    dt,
  );
  state.headYawVelocity = springVelocity;
  state.headPitch = springTo(
    state.headPitch,
    state.headPitchVelocity,
    pitch,
    1.6,
    0.9,
    dt,
  );
  state.headPitchVelocity = springVelocity;
}

/** Each tail segment's bend toward its pose, the far ones lagging: follow
 * through, and a swish that travels down it. */
function stepTail(state: CatState, host: CatHost, dt: number) {
  const n = TAIL_SEGMENTS;
  const t = state.clock;
  const sit = MathUtils.clamp(state.rest, 0, 1);
  const lie = MathUtils.clamp(state.rest - 1, 0, 1);
  const curlSide = state.side;
  const swishRate = host.dancing ? 2.2 : 0.9;
  const swish =
    (1 - state.moving) * (1 - sit) * 0.22 +
    (host.dancing ? 0.25 : 0) +
    state.moving * 0.1;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    // Standing and walking: up from the rump and curving over at the tip;
    // sitting: down to the ground and round its feet (the hips are rocked
    // back, nose up, which already tips the root down); lying: wrapped
    // round it.
    const standPitch = i === 0 ? 0.55 : 0.12 + f * 0.1;
    const sitPitch = i === 0 ? -0.15 : i === 1 ? 0.85 : 0.04;
    const liePitch = i === 0 ? -0.6 : i === 1 ? 0.55 : 0.02;
    let pitch =
      MathUtils.lerp(MathUtils.lerp(standPitch, sitPitch, sit), liePitch, lie) -
      state.trot * state.moving * (i === 0 ? 0.35 : 0.04);
    const curl = MathUtils.lerp(0.42, 0.62, lie) * Math.max(sit, lie);
    let yaw = i === 0 ? 0 : curlSide * curl;
    // Swish: a wave that travels down the tail.
    const wave =
      state.moving > 0.5
        ? Math.sin(state.phase * Math.PI * 2 - i * 0.5)
        : Math.sin(t * Math.PI * 2 * swishRate * 0.5 - i * 0.6);
    yaw += wave * swish * (0.3 + f);
    // Follow through: it lags the body's turn.
    yaw -= state.turnRate * 0.05 * (i === 0 ? 1 : 0.4);
    // A flick of the tip.
    if (state.flick >= 0 && i >= n - 2) {
      yaw +=
        envelope(state.flick, FLICK_SECONDS) * Math.sin(state.flick * 22) * 0.5;
    }
    if (state.rest > 2.5) yaw *= 1 + Math.sin(t * 0.6) * 0.05;
    const freq = 3.4 - f * 1.6;
    state.tailYaw[i] = springTo(
      state.tailYaw[i],
      state.tailYawVelocity[i],
      yaw,
      freq,
      0.45,
      dt,
    );
    state.tailYawVelocity[i] = springVelocity;
    pitch += state.slopePitch * (i === 0 ? -0.5 : 0);
    state.tailPitch[i] = springTo(
      state.tailPitch[i],
      state.tailPitchVelocity[i],
      pitch,
      freq,
      0.6,
      dt,
    );
    state.tailPitchVelocity[i] = springVelocity;
  }
}

/** Whether a fetch has landed on its item (the pounce is done). */
export function catHasCaught(state: CatState): boolean {
  return state.fetch === "holding";
}

/** How far into its pounce it is (0..1), or −1 when it isn't pouncing. */
export function catPounce(state: CatState): number {
  if (state.hop >= 0) return Math.min(1, state.hop / HOP_SECONDS);
  return state.fetch === "pounce" ? state.pounce / POUNCE_SECONDS : -1;
}

/** Whether it's up on its herzie's prop, or on its way up. */
export function catOnProp(state: CatState): boolean {
  return state.perched || (state.hop >= 0 && state.hopUp);
}

/** The pounce's hop (world units at size 1) at `t` through it. */
export function pounceLift(t: number): number {
  if (t < POUNCE_LEAP || t > POUNCE_LAND) return 0;
  return POUNCE_HOP * bump((t - POUNCE_LEAP) / (POUNCE_LAND - POUNCE_LEAP));
}

/** The crouch before the leap and the squat on landing, 0..1. */
export function pounceCrouch(t: number): number {
  if (t < 0) return 0;
  if (t < POUNCE_LEAP) return MathUtils.smoothstep(t, 0, POUNCE_LEAP * 0.6);
  if (t > POUNCE_LAND) return bump((t - POUNCE_LAND) / (1 - POUNCE_LAND)) * 0.6;
  return 0;
}

export const CAT_TIMING = {
  STRETCH_SECONDS,
  YAWN_SECONDS,
  GROOM_SECONDS,
  BLINK_SECONDS,
  TWITCH_SECONDS,
  SIT_AFTER,
  LIE_AFTER,
  SLEEP_AFTER,
} as const;
