import {
  type ShipIndex,
  type ShipState,
  shipState,
  WILDS_LEG_S,
  type WildsService,
} from "@herzies/shared";
import { legPath } from "./path";

/**
 * Where the sky ship is, and how it's turned, at any moment: a pure
 * function of the timetable (wilds.ts) and the time, so everyone sees it
 * in the same place without a word on the wire.
 *
 * Each leg (dock to dock) is worked out once — "baked" — at 60 samples a
 * second: the path through the sky, how fast along it, and the heading,
 * bank and pitch put through the springs and pendulum lag that make a big
 * ship look heavy. Springs need a history, which a pure function of time
 * can't have; baking gives them one that is the same for everyone. On top
 * of the baked leg go the motions that are closed-form in absolute time:
 * the gentle float, gusts, the anticipation dip before lifting off and the
 * settle after touching down.
 *
 * The leg's shape (local://research-ship-feel.md has the reasoning):
 * - Horizontally, the gentlest arc-straight-arc way from berth to berth,
 *   smoothed so its curvature (and so the bank) flows (see path.ts),
 *   walked at a smootherstep speed profile: zero speed and acceleration at
 *   both ends, a long cruise between.
 * - Vertically, a straight lift off the berth (it lies broadside to a
 *   pier: up first, then away), a climb to cruise height overlapping the
 *   start of the forward run, and the reverse at the far end, the last two
 *   seconds a pure vertical settle.
 * - Heading from the path's tangent (defined even when stopped), through a
 *   critically damped spring; bank into turns from the turn's lateral
 *   acceleration, exaggerated a little, through an underdamped pendulum;
 *   pitch from the climb and (as a boat does) bow up under acceleration.
 *
 * Coordinates are the sky's (each island's `origin` plus its own frame).
 */

/** A ship's berth in the sky: where its deck's origin is, and its bow's
 * heading (forward is (sin, cos)). */
export type SkyBerth = { x: number; y: number; z: number; yaw: number };

/** Bake rate. */
const HZ = 60;
const LEG_S = WILDS_LEG_S;
/** The forward run starts this long after lift-off, and ends this long
 * before touchdown (the last of the descent is straight down). */
const RUN_FROM = 1.5;
const RUN_TO = LEG_S - 2;
/** How long the smootherstep ramps up to cruise speed take, and back down. */
const RAMP = 9;
/** The lift off a berth and the drop onto one: how high, how long. */
const LIFT = 10;
const LIFT_S = 7;
/** The fastest a ship cruises: a longer way round than this allows takes
 * tighter turns instead. */
const MAX_CRUISE = 9;
/** Heading spring's half-life (s). */
const YAW_HALF_LIFE = 0.35;
/** Bank: exaggeration of the true coordinated-turn angle, its limit, and
 * the pendulum it swings on (rad/s, damping ratio). */
const BANK_GAIN = 1.6;
const BANK_MAX = (9 * Math.PI) / 180;
const BANK_W = 2.2;
const BANK_ZETA = 0.75;
/** Pitch: degrees of climb pitch per unit/s climbed and its limit; bow up
 * per unit/s² of acceleration and its limit; its spring. */
const CLIMB_PITCH = (1.6 * Math.PI) / 180;
const CLIMB_MAX = (5 * Math.PI) / 180;
const SURGE_PITCH = (1.6 * Math.PI) / 180;
const SURGE_MAX = (2.5 * Math.PI) / 180;
const PITCH_W = 2;
const PITCH_ZETA = 0.7;
/** The world's pull, for the bank angle. */
const G = 9.81;

/** One leg, baked. Per sample: position, velocity, heading (unwrapped),
 * bank, pitch (bow up), forward speed and acceleration, turn rate. */
export type Leg = {
  from: SkyBerth;
  to: SkyBerth;
  /** Horizontal length of the path. */
  length: number;
  /** Cruising speed. */
  cruise: number;
  n: number;
  pos: Float64Array;
  vel: Float64Array;
  yaw: Float64Array;
  roll: Float64Array;
  pitch: Float64Array;
  speed: Float64Array;
  accel: Float64Array;
  turn: Float64Array;
};

const smootherstep = (x: number) => x * x * x * (x * (x * 6 - 15) + 10);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x: number, lo: number, hi: number) =>
  x < lo ? lo : x > hi ? hi : x;

/** Minimum-jerk 0 → 1 over [0, 1], and its rate (per unit of x). */
const minJerk = (x: number) => smootherstep(clamp01(x));
const minJerkRate = (x: number) =>
  x <= 0 || x >= 1 ? 0 : 30 * x * x * (x - 1) * (x - 1);

/** How far along the path at time `t` into the run (closed form: a
 * smootherstep velocity ramp up, cruise, and the mirror image down), its
 * speed and acceleration. */
export function runAlong(
  t: number,
  T: number,
  ramp: number,
  cruise: number,
): { s: number; v: number; a: number } {
  // Distance covered over a ramp's first x of the way: V·Ta·(x⁶ − 3x⁵ +
  // 2.5x⁴), which is V·Ta/2 by its end.
  const up = (x: number) => cruise * ramp * x * x * x * x * (x * (x - 3) + 2.5);
  if (t <= 0) return { s: 0, v: 0, a: 0 };
  if (t >= T) return { s: cruise * (T - ramp), v: 0, a: 0 };
  if (t < ramp) {
    const x = t / ramp;
    return {
      s: up(x),
      v: cruise * smootherstep(x),
      a: (cruise / ramp) * minJerkRate(x),
    };
  }
  if (t > T - ramp) {
    const x = (T - t) / ramp;
    return {
      s: cruise * (T - ramp) - up(x),
      v: cruise * smootherstep(x),
      a: -(cruise / ramp) * minJerkRate(x),
    };
  }
  return { s: cruise * ramp * 0.5 + cruise * (t - ramp), v: cruise, a: 0 };
}

/** Height above the leg's start, and its rate, at time `t` into the leg:
 * the lift, a blend from one berth's height to the other's, and the
 * drop. */
function altitude(
  t: number,
  y0: number,
  y1: number,
): { y: number; vy: number } {
  const span = LEG_S - 4;
  const mid = (t - 2) / span;
  const rise = t / LIFT_S;
  const fall = (t - (LEG_S - LIFT_S)) / LIFT_S;
  return {
    y: y0 + (y1 - y0) * minJerk(mid) + LIFT * (minJerk(rise) - minJerk(fall)),
    vy:
      ((y1 - y0) * minJerkRate(mid)) / span +
      (LIFT * (minJerkRate(rise) - minJerkRate(fall))) / LIFT_S,
  };
}

/** Unwrap `a` to within π of `near`. */
const nearAngle = (a: number, near: number) =>
  a + Math.round((near - a) / (2 * Math.PI)) * 2 * Math.PI;

/** Round things a leg keeps clear of, seen from above (x, z, radius). */
export type Keepout = { x: number; z: number; r: number };

/** Bake the leg from one berth to the other, keeping out of `avoid`. */
export function bakeLeg(
  from: SkyBerth,
  to: SkyBerth,
  avoid: readonly Keepout[] = [],
): Leg {
  const T = RUN_TO - RUN_FROM;
  const path = legPath(from, to, T - RAMP, MAX_CRUISE, avoid);
  const length = path.length;
  const cruise = length / (T - RAMP);
  const p = [0, 0];

  const n = Math.round(LEG_S * HZ) + 1;
  const leg: Leg = {
    from,
    to,
    length,
    cruise,
    n,
    pos: new Float64Array(n * 3),
    vel: new Float64Array(n * 3),
    yaw: new Float64Array(n),
    roll: new Float64Array(n),
    pitch: new Float64Array(n),
    speed: new Float64Array(n),
    accel: new Float64Array(n),
    turn: new Float64Array(n),
  };
  const dt = 1 / HZ;
  const tan = [0, 0];
  let yaw = from.yaw;
  let yawTarget = from.yaw;
  let roll = 0;
  let rollRate = 0;
  let pitch = 0;
  let pitchRate = 0;
  const yawKeep = 2 ** (-dt / YAW_HALF_LIFE);
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const run = runAlong(t - RUN_FROM, T, RAMP, cruise);
    path.at(run.s, p, tan);
    const tx = tan[0];
    const tz = tan[1];
    const alt = altitude(t, from.y, to.y);
    leg.pos[i * 3] = p[0];
    leg.pos[i * 3 + 1] = alt.y;
    leg.pos[i * 3 + 2] = p[1];
    leg.vel[i * 3] = tx * run.v;
    leg.vel[i * 3 + 1] = alt.vy;
    leg.vel[i * 3 + 2] = tz * run.v;
    // Heading: the tangent's, unwrapped, through the spring.
    yawTarget = nearAngle(Math.atan2(tx, tz), yawTarget);
    const prevYaw = yaw;
    yaw = yawTarget + (yaw - yawTarget) * yawKeep;
    const turn = i === 0 ? 0 : (yaw - prevYaw) / dt;
    // Bank: rolled into the turn (the lift tilts toward its middle, which
    // is on the ship's +x side when the heading grows), on a pendulum.
    const bankTarget = clamp(
      -BANK_GAIN * Math.atan((run.v * turn) / G),
      -BANK_MAX,
      BANK_MAX,
    );
    rollRate +=
      (BANK_W * BANK_W * (bankTarget - roll) -
        2 * BANK_ZETA * BANK_W * rollRate) *
      dt;
    roll += rollRate * dt;
    // Pitch: up with the climb (once it's under way: a straight lift off
    // the berth stays level), bow up under acceleration.
    const underway = clamp01(run.v / (0.5 * cruise));
    const pitchTarget =
      clamp(CLIMB_PITCH * alt.vy, -CLIMB_MAX, CLIMB_MAX) * underway +
      clamp(SURGE_PITCH * run.a, -SURGE_MAX, SURGE_MAX);
    pitchRate +=
      (PITCH_W * PITCH_W * (pitchTarget - pitch) -
        2 * PITCH_ZETA * PITCH_W * pitchRate) *
      dt;
    pitch += pitchRate * dt;
    leg.yaw[i] = yaw;
    leg.roll[i] = roll;
    leg.pitch[i] = pitch;
    leg.speed[i] = run.v;
    leg.accel[i] = run.a;
    leg.turn[i] = turn;
  }
  // The springs lag: bring the last few seconds round to exactly the far
  // berth's heading, level, so the leg meets the ship lying there.
  const end = n - 1;
  const yawErr = leg.yaw[end] - nearAngle(to.yaw, leg.yaw[end]);
  const fix = Math.round(3 * HZ);
  for (let i = end - fix; i <= end; i++) {
    const k = smootherstep((i - (end - fix)) / fix);
    leg.yaw[i] -= yawErr * k;
    leg.roll[i] *= 1 - k;
    leg.pitch[i] *= 1 - k;
  }
  return leg;
}

/** A ship's pose and what its moving parts need. */
export type ShipPose = {
  x: number;
  y: number;
  z: number;
  /** Heading (forward is (sin, cos)), bank (+ rolls its up toward −x) and
   * pitch (+ is bow up). Euler order YXZ: yaw, then −pitch about x, then
   * roll about z. */
  yaw: number;
  roll: number;
  pitch: number;
  /** The float's rise and fall included in `y` (the camera takes most of
   * it back out, so the horizon doesn't bob). */
  heave: number;
  /** Forward speed (u/s), acceleration (u/s²) and turn rate (rad/s). */
  speed: number;
  accel: number;
  turnRate: number;
  /** Engines: 0 idle – 1 flat out. */
  throttle: number;
  /** 0 flying – 1 tied up (its lines out). */
  moored: number;
  /** 0 stowed – 1 run out to the pier. */
  gangplank: number;
  /** A gust's swell now, −1..1. */
  gust: number;
  state: ShipState;
};

export function emptyPose(): ShipPose {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    roll: 0,
    pitch: 0,
    heave: 0,
    speed: 0,
    accel: 0,
    turnRate: 0,
    throttle: 0,
    moored: 1,
    gangplank: 0,
    gust: 0,
    state: {
      kind: "docked",
      at: "home",
      since: Number.NEGATIVE_INFINITY,
      until: null,
    },
  };
}

/** The leg sampled `t` seconds in (clamped), into `out`'s path fields:
 * Hermite between samples for position, linear for the rest. */
export function sampleLeg(leg: Leg, t: number, out: ShipPose): void {
  const f = clamp(t, 0, LEG_S) * HZ;
  const i = Math.min(leg.n - 2, Math.floor(f));
  const k = f - i;
  const j = i + 1;
  const dt = 1 / HZ;
  // Cubic Hermite basis.
  const k2 = k * k;
  const k3 = k2 * k;
  const h00 = 2 * k3 - 3 * k2 + 1;
  const h10 = k3 - 2 * k2 + k;
  const h01 = -2 * k3 + 3 * k2;
  const h11 = k3 - k2;
  const P = leg.pos;
  const V = leg.vel;
  out.x =
    h00 * P[i * 3] + h10 * dt * V[i * 3] + h01 * P[j * 3] + h11 * dt * V[j * 3];
  out.y =
    h00 * P[i * 3 + 1] +
    h10 * dt * V[i * 3 + 1] +
    h01 * P[j * 3 + 1] +
    h11 * dt * V[j * 3 + 1];
  out.z =
    h00 * P[i * 3 + 2] +
    h10 * dt * V[i * 3 + 2] +
    h01 * P[j * 3 + 2] +
    h11 * dt * V[j * 3 + 2];
  const lerp = (a: Float64Array) => a[i] + (a[j] - a[i]) * k;
  out.yaw = lerp(leg.yaw);
  out.roll = lerp(leg.roll);
  out.pitch = lerp(leg.pitch);
  out.speed = lerp(leg.speed);
  out.accel = lerp(leg.accel);
  out.turnRate = lerp(leg.turn);
}

// --- The motions on top, closed-form in absolute time --------------------

/** A steady pseudo-random number in [0, 1) for an integer. */
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Gusts: every 7 s slot has a one-in-three chance of one, 2.5–3.5 s
 * long, landing somewhere in its first 4 s. −1..1, smooth. */
export function gustAt(t: number, seed: number): number {
  let g = 0;
  const slot = Math.floor(t / 7);
  for (let s = slot - 1; s <= slot; s++) {
    const r = hash(s * 7.31 + seed * 101.3);
    if (r >= 0.35) continue;
    const start = s * 7 + hash(s + seed * 13.7) * 4;
    const len = 2.5 + hash(s * 3.1 + seed) * 1;
    const x = (t - start) / len;
    if (x <= 0 || x >= 1) continue;
    const sign = hash(s * 1.7 + seed * 5.3) < 0.5 ? -1 : 1;
    g += sign * (0.5 + r / 0.7) * Math.sin(Math.PI * x) ** 2;
  }
  return clamp(g, -1, 1);
}

/** The settle after touching down, `t` seconds after: a damped sine
 * dipping first (0.15 at 0.9 Hz, damping 0.55: about 12% overshoot). */
function settle(t: number): number {
  if (t < 0 || t > 5) return 0;
  const w = TAU * 0.9;
  const zeta = 0.55;
  return (
    -0.15 *
    Math.exp(-zeta * w * t) *
    Math.sin(w * Math.sqrt(1 - zeta * zeta) * t)
  );
}

/** The squat before lifting off, `t` seconds from the moment it does. */
function dip(t: number): number {
  if (t < -0.6 || t > 0.6) return 0;
  return -0.1 * Math.cos((Math.PI * t) / 1.2) ** 2;
}

/** How long the gangplank takes to run out or be drawn in (s). */
export const PLANK_MOVE_S = 1.5;
/** It's in this long before the ship casts off (s), so nobody's still
 * trying to climb a plank that's closed in the last seconds. It closes the
 * moment it starts coming in. */
export const PLANK_IN_BY_S = 5;
/** Laid up after its last run, it's in this long after the ship tied up
 * (s): time for whoever's still aboard to be seen off down it (see
 * boarding.ts's LAID_UP_GRACE_MS). */
export const PLANK_LAID_UP_S = 20;

/** How much the gangplank's run out, `from` when it can be (the ship tied
 * up, or a service opened with it lying there; null: never, it's laid
 * up) and `until` the ship casts off (null: it's laid up), at `t` (all
 * seconds): out once it's settled, in a little before it casts off — or,
 * laid up after a run, once its last passengers are off. */
function gangplankAt(t: number, from: number | null, until: number | null) {
  if (from === null) return 0;
  const out = smootherstep(clamp01((t - from - 1) / PLANK_MOVE_S));
  const inFrom =
    until === null
      ? from + PLANK_LAID_UP_S
      : until - PLANK_IN_BY_S - PLANK_MOVE_S;
  const back = smootherstep(clamp01((t - inFrom) / PLANK_MOVE_S));
  return Math.min(out, 1 - back);
}

/** Where the legs and berths are, for `shipPose`. */
export type Route = {
  home: SkyBerth;
  wilds: SkyBerth;
  /** Home to the Wilds, and back. */
  out: Leg;
  back: Leg;
};

export function buildRoute(
  home: SkyBerth,
  wilds: SkyBerth,
  avoid: readonly Keepout[] = [],
): Route {
  return {
    home,
    wilds,
    out: bakeLeg(home, wilds, avoid),
    back: bakeLeg(wilds, home, avoid),
  };
}

/** Ship `ship`'s pose at `now` (ms since the epoch) on `service`. */
export function shipPose(
  route: Route,
  service: WildsService | null,
  ship: ShipIndex,
  now: number,
  out: ShipPose,
): ShipPose {
  const st = shipState(service, ship, now);
  out.state = st;
  const t = now / 1000;
  // How lively its float is: a third as much tied up as in flight.
  let lively = 0.35;
  if (st.kind === "docked") {
    const b = st.at === "home" ? route.home : route.wilds;
    out.x = b.x;
    out.y = b.y;
    out.z = b.z;
    out.yaw = b.yaw;
    out.roll = 0;
    out.pitch = 0;
    out.speed = 0;
    out.accel = 0;
    out.turnRate = 0;
    const since = st.since / 1000;
    const until = st.until === null ? null : st.until / 1000;
    // Lying here since before anyone remembers: its plank's stowed, unless
    // a service has opened (it runs out then, for boarding).
    const plankFrom = Number.isFinite(since)
      ? since
      : until !== null && service
        ? service.startsAt / 1000
        : null;
    out.gangplank = gangplankAt(t, plankFrom, until);
    // Tied up (its lines out, its wings folded) all the while it lies
    // here: they're slipped and spread once it's lifted clear (below).
    out.moored = 1;
    // Engines tick over while it waits for a departure; quiet laid up.
    out.throttle =
      until === null
        ? 0
        : 0.12 + 0.2 * smootherstep(clamp01((t - (until - 1.5)) / 1.5));
    out.y += settle(t - since) + (until === null ? 0 : dip(t - until));
  } else {
    const leg = st.from === "home" ? route.out : route.back;
    const into = (now - st.departedAt) / 1000;
    sampleLeg(leg, into, out);
    out.gangplank = 0;
    // Its wings stay folded (and its lines out) till it's lifted clear of
    // the island's rim, and fold again before it settles beside the next.
    out.moored = Math.max(
      1 - smootherstep(clamp01((into - 2.5) / 1.5)),
      smootherstep(clamp01((into - (LEG_S - 3)) / 2)),
    );
    out.throttle = clamp(
      0.25 + (0.6 * out.speed) / leg.cruise + Math.abs(out.accel) * 0.35,
      0,
      1,
    );
    out.y += dip(into);
    // Livelier as it gets going, calmer as it comes in.
    lively += 0.65 * Math.min(minJerk(into / 5), minJerk((LEG_S - into) / 5));
  }
  // The float: sums of slow sines at unrelated rates.
  const heave =
    0.12 *
    lively *
    (0.6 * Math.sin(TAU * 0.07 * t) +
      0.3 * Math.sin(TAU * 0.113 * t + 1.7) +
      0.1 * Math.sin(TAU * 0.181 * t + 4.1));
  const gust = gustAt(t, 1) * clamp01((lively - 0.35) / 0.65);
  out.gust = gust;
  out.heave = heave + 0.1 * Math.abs(gust);
  out.y += out.heave;
  out.roll +=
    DEG *
    (0.8 *
      lively *
      (0.7 * Math.sin(TAU * 0.09 * t + 0.6) +
        0.3 * Math.sin(TAU * 0.146 * t + 2.2)) +
      1.5 * gust);
  out.pitch +=
    DEG *
    0.5 *
    lively *
    (0.7 * Math.sin(TAU * 0.06 * t + 3.3) +
      0.3 * Math.sin(TAU * 0.097 * t + 0.4));
  out.yaw += DEG * 0.6 * gust;
  return out;
}
