/**
 * How a crow moves: a small state machine with real acceleration, kept
 * apart from the scene (no THREE, no React) so it can be tested on its own;
 * Birds drives the models with it.
 *
 * What it borrows from how birds (and animators) do it:
 *  - Anticipation: a bird doesn't just leave. It turns to face the way it
 *    will go, crouches, opens its wings and gives a couple of half-beats
 *    first; a startled one does the same in a fraction of the time.
 *  - Acceleration: it springs off the perch with a leap, then speeds up
 *    under a limited acceleration, cruises, and on the way in brakes at a
 *    limited deceleration so it arrives slow (a stopping-distance
 *    controller, as for steering "arrive" behaviours). It never moves by a
 *    curve fitted to the path.
 *  - Wingbeats follow effort (see Wu & Popovic, "Realistic modeling of
 *    bird flight animations"): the take-off is a burst of quick, deep
 *    beats, the climb strong ones, the cruise a few easy beats with
 *    glides between, and the landing a flared, back-pitched flurry. Each
 *    beat is lopsided (a short power downstroke, a longer recovery), and
 *    the tips lag the shoulder, so the wing whips instead of hinging.
 *  - Follow-through: touching down the wings fold with an overshoot, the
 *    body squashes and settles; perched, it looks about, nods, and
 *    ruffles its wings now and then.
 *  - Flocking: when one startles, its neighbours go a beat later.
 *
 * Everything is world space, frame-rate independent (fixed substeps), and
 * allocation-free per step.
 */

export type Spot = { x: number; y: number; z: number; yaw: number };

/** Every number in one place, so the feel can be tuned without hunting. */
export const FLIGHT = {
  /** Cruise speed, and the most it speeds up and slows down (units/s,
   * units/s²). */
  cruise: 6.5,
  accel: 7.5,
  decel: 6,
  /** The speed it's allowed to arrive at (it brakes to this). */
  landSpeed: 0.8,
  /** The upward leap off the perch (units/s). */
  leap: 3.4,
  /** Anticipation before it leaves (s): a calm bird's (between), a
   * startled one's. */
  prep: [0.45, 0.7] as const,
  startle: 0.17,
  /** Settling after touching down (s). */
  settle: 0.65,
  /** The most it arcs up over a flight, at any distance. */
  maxArc: 5,
  /** Neighbours this close go too, a beat after a startled bird. */
  flushRange: 6.5,
  flushDelay: [0.06, 0.34] as const,
} as const;

/** How steeply it comes down into a landing: height per unit of ground
 * still to cover. */
const GLIDE_SLOPE = 0.4;

/** Wing tips' height at full fold (the beat value that lays the wings
 * down along the back; see Birds' wing material). */
export const FOLDED = -1.3;

/** Where in its beat a wing is, as a height: 1 tips up, -1 tips down.
 * Lopsided: the power downstroke takes 40% of a beat, the recovery 60%. */
export function wingWave(phase: number): number {
  const p = phase - Math.floor(phase);
  return p < 0.4
    ? Math.cos((Math.PI * p) / 0.4)
    : -Math.cos((Math.PI * (p - 0.4)) / 0.6);
}

export type Phase = "perched" | "prep" | "flying" | "settle";

/** What to draw: where the bird is, how it's turned and tilted, and its
 * wings — `beat` the shoulder's, `tip` the (lagging) tips', `spread` how
 * wide they are (folded wings are narrow). */
export type Pose = {
  x: number;
  y: number;
  z: number;
  heading: number;
  /** Nose up is positive. */
  pitch: number;
  /** Tilt about its own length; a left turn is negative. */
  roll: number;
  beat: number;
  tip: number;
  spread: number;
};

export type Bird = {
  phase: Phase;
  /** Seconds in this phase. */
  t: number;
  /** Where it is (the ground, while it sits). */
  x: number;
  y: number;
  z: number;
  heading: number;
  /** Its seed: sets one bird's habits apart from the next. */
  seed: number;
  pose: Pose;

  // Perched.
  /** Where it's looking, relative to its perch's facing, and when it next
   * looks elsewhere. */
  look: number;
  lookTo: number;
  lookIn: number;
  nodT: number;
  nodIn: number;
  ruffleT: number;
  ruffleIn: number;
  /** Counting down to a flush (a neighbour startled); Infinity: none. */
  flushIn: number;

  // The flight.
  from: Spot;
  to: Spot;
  dist: number;
  dirX: number;
  dirZ: number;
  lateral: number;
  vmax: number;
  arc: number;
  /** Where the prep turns it, and how long it lasts. */
  aim: number;
  prepFor: number;
  /** How far along the ground it's got, how fast it's going, and how
   * fast it's climbing. */
  s: number;
  speed: number;
  yv: number;
  accelNow: number;
  headingRate: number;

  // The wings.
  wingPhase: number;
  /** Beats a second, and how deep, as shown (eased toward the effort). */
  rate: number;
  amp: number;
  /** 0 flapping, 1 gliding (eased). */
  glide: number;
  /** 0 spread, 1 folded; and its velocity (it springs). */
  fold: number;
  foldVel: number;
  /** Lowered body (a crouch) and its tilt, added to the pose. */
  lift: number;
};

export type Rand = () => number;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** An exponential approach: `rate` per second, frame-rate independent. */
const approach = (v: number, to: number, rate: number, dt: number) =>
  v + (to - v) * (1 - Math.exp(-rate * dt));
const turn = (from: number, to: number, rate: number, dt: number) =>
  from + wrap(to - from) * (1 - Math.exp(-rate * dt));
const between = (r: readonly [number, number], rand: Rand) =>
  r[0] + rand() * (r[1] - r[0]);

/** The fixed step everything's integrated at (s). */
const STEP = 1 / 90;

/** A bird sitting on a perch. */
export function perchedBird(at: Spot, seed: number, rand: Rand): Bird {
  const spot = { ...at };
  return {
    phase: "perched",
    t: 0,
    x: at.x,
    y: at.y,
    z: at.z,
    heading: at.yaw,
    seed,
    pose: {
      x: at.x,
      y: at.y,
      z: at.z,
      heading: at.yaw,
      pitch: 0,
      roll: 0,
      beat: FOLDED,
      tip: FOLDED,
      spread: 0.35,
    },
    look: 0,
    lookTo: 0,
    lookIn: 1 + rand() * 5,
    nodT: 0,
    nodIn: 2 + rand() * 6,
    ruffleT: 0,
    ruffleIn: 8 + rand() * 20,
    flushIn: Number.POSITIVE_INFINITY,
    from: spot,
    to: { ...spot },
    dist: 0,
    dirX: 0,
    dirZ: 1,
    lateral: 0,
    vmax: FLIGHT.cruise,
    arc: 0,
    aim: at.yaw,
    prepFor: 0,
    s: 0,
    speed: 0,
    yv: 0,
    accelNow: 0,
    headingRate: 0,
    wingPhase: rand(),
    rate: 0,
    amp: 0,
    glide: 0,
    fold: 1,
    foldVel: 0,
    lift: 0,
  };
}

/** Where a bird is now, as a spot (the way it faces as its yaw). */
export function spotOf(b: Bird): Spot {
  return { x: b.x, y: b.y, z: b.z, yaw: b.heading };
}

/** Whether it's free to be told to go. */
export function isPerched(b: Bird): boolean {
  return b.phase === "perched";
}

/** Tells a perched bird to fly to `to`: it starts its anticipation (see
 * the top). `startled`: a fast one. Returns false if it's already going. */
export function startFlight(
  b: Bird,
  to: Spot,
  startled: boolean,
  rand: Rand,
): boolean {
  if (b.phase !== "perched") return false;
  const dx = to.x - b.x;
  const dz = to.z - b.z;
  const dist = Math.max(0.5, Math.hypot(dx, dz));
  b.from = { x: b.x, y: b.y, z: b.z, yaw: b.heading };
  b.to = { ...to };
  b.dist = dist;
  b.dirX = dx / dist;
  b.dirZ = dz / dist;
  b.lateral = (rand() * 2 - 1) * Math.min(1, dist / 12) * 1.4;
  b.arc = Math.min(FLIGHT.maxArc, 1.4 + dist * 0.22);
  b.vmax = Math.min(FLIGHT.cruise, 2.2 + dist * 0.55);
  b.aim = Math.atan2(dx, dz);
  b.prepFor = startled ? FLIGHT.startle : between(FLIGHT.prep, rand);
  b.phase = "prep";
  b.t = 0;
  b.flushIn = Number.POSITIVE_INFINITY;
  return true;
}

/** One frame: advances the bird by `dt` and returns its pose (the same
 * object each time). `rand` only for its idle habits. */
export function stepBird(b: Bird, dt: number, rand: Rand): Pose {
  let left = Math.min(dt, 0.1);
  const n = Math.max(1, Math.ceil(left / STEP));
  const h = left / n;
  for (let i = 0; i < n; i++) {
    tick(b, h, rand);
    left -= h;
  }
  writePose(b);
  return b.pose;
}

function tick(b: Bird, dt: number, rand: Rand) {
  b.t += dt;
  if (b.phase === "perched") perched(b, dt, rand);
  else if (b.phase === "prep") prep(b, dt);
  else if (b.phase === "flying") flying(b, dt);
  else settle(b, dt);
  b.flushIn -= dt;
}

/** Folds or spreads the wings by a spring: critically damped, or
 * underdamped (`zeta` < 1) so they overshoot. */
function springFold(
  b: Bird,
  to: number,
  omega: number,
  zeta: number,
  dt: number,
) {
  b.foldVel +=
    (-2 * zeta * omega * b.foldVel - omega * omega * (b.fold - to)) * dt;
  b.fold += b.foldVel * dt;
}

function perched(b: Bird, dt: number, rand: Rand) {
  // Looking about: a glance one way, held, then another (or back).
  b.lookIn -= dt;
  if (b.lookIn <= 0) {
    b.lookTo =
      rand() < 0.35 ? 0 : (rand() < 0.5 ? -1 : 1) * (0.4 + rand() * 0.8);
    b.lookIn = 1.2 + rand() * 5;
  }
  b.look = approach(b.look, b.lookTo, 7, dt);
  b.heading = turn(b.heading, b.from.yaw + b.look, 14, dt);
  // A nod: the head dips and comes up (the whole body's, here).
  b.nodIn -= dt;
  if (b.nodIn <= 0 && b.nodT <= 0) {
    b.nodT = 0.28;
    b.nodIn = 2.5 + rand() * 7;
  }
  b.nodT = Math.max(0, b.nodT - dt);
  const nod = b.nodT > 0 ? Math.sin((1 - b.nodT / 0.28) * Math.PI) : 0;
  // A ruffle: the wings come half open and shiver, then settle.
  b.ruffleIn -= dt;
  if (b.ruffleIn <= 0 && b.ruffleT <= 0) {
    b.ruffleT = 0.7;
    b.ruffleIn = 10 + rand() * 25;
  }
  b.ruffleT = Math.max(0, b.ruffleT - dt);
  const ruffling = b.ruffleT > 0;
  const shake = ruffling ? Math.sin(Math.PI * (1 - b.ruffleT / 0.7)) : 0;
  springFold(b, ruffling ? 0.55 : 1, 16, 0.8, dt);
  b.rate = approach(b.rate, ruffling ? 15 : 0, 20, dt);
  b.amp = approach(b.amp, ruffling ? 0.35 * shake : 0, 20, dt);
  b.glide = 0;
  b.wingPhase += b.rate * dt;
  b.lift = -0.012 * nod;
  b.pose.pitch = -0.1 * nod + Math.sin(b.t * 1.7 + b.seed) * 0.015;
  b.speed = 0;
  b.yv = 0;
  b.accelNow = 0;
  b.headingRate = 0;
  b.x = b.from.x;
  b.y = b.from.y;
  b.z = b.from.z;
}

function prep(b: Bird, dt: number) {
  const u = clamp(b.t / b.prepFor, 0, 1);
  // Turn to face where it's going, quickly.
  const before = b.heading;
  b.heading = turn(b.heading, b.aim, 11, dt);
  b.headingRate = wrap(b.heading - before) / dt;
  // Crouch, nose down, then the spring up before it goes.
  b.lift = -0.07 * smooth(0, 0.7, u) + 0.05 * smooth(0.82, 1, u);
  b.pose.pitch = -0.24 * smooth(0, 0.7, u) + 0.2 * smooth(0.85, 1, u);
  // The wings open and give a couple of half-beats.
  springFold(b, 1 - 0.8 * smooth(0.12, 0.68, u), 18, 0.8, dt);
  b.rate = approach(b.rate, 7.5, 12, dt);
  b.amp = approach(b.amp, 0.42 * smooth(0.25, 0.9, u), 14, dt);
  b.glide = 0;
  b.wingPhase += b.rate * dt;
  b.speed = 0;
  b.accelNow = 0;
  if (b.t >= b.prepFor) {
    b.phase = "flying";
    b.t = 0;
    b.s = 0;
    b.speed = 1;
    b.yv = FLIGHT.leap;
    // The first beats are the hardest.
    b.rate = 19;
    b.amp = 1;
    b.lift = 0;
  }
}

function flying(b: Bird, dt: number) {
  const { dist } = b;
  // The speed it'd like to be at: cruise, but never more than it can
  // stop from before the end (arriving at the landing speed).
  const remaining = Math.max(0, dist - b.s);
  const want = Math.min(
    b.vmax,
    Math.sqrt(2 * FLIGHT.decel * remaining + FLIGHT.landSpeed ** 2),
  );
  const before = b.speed;
  b.speed += clamp(want - b.speed, -FLIGHT.decel * dt, FLIGHT.accel * dt);
  b.accelNow = (b.speed - before) / dt;
  const ds = b.speed * dt;
  b.s = Math.min(dist, b.s + ds);
  const u = b.s / dist;

  // Along the line, swinging a little to one side and back.
  const px = -b.dirZ;
  const pz = b.dirX;
  const lat = Math.sin(Math.PI * u) * b.lateral;
  const nx = b.from.x + b.dirX * b.s + px * lat;
  const nz = b.from.z + b.dirZ * b.s + pz * lat;
  const dx = nx - b.x;
  const dz = nz - b.z;
  b.x = nx;
  b.z = nz;

  // Height: a critically damped spring after where the flight wants to
  // be (up quickly, held, then down into the landing), kicked off by the
  // leap — so it climbs out with momentum and eases in, not on rails.
  const base = lerp(b.from.y, b.to.y, smooth(0, 1, u));
  // Up quickly, but down only as fast as a glide slope allows: the
  // height above the perch is capped by the distance still to go (about
  // two in five), so it settles into the landing instead of dropping out.
  const climbed = b.arc * smooth(0, 0.28, u);
  const target = base + Math.min(climbed, remaining * GLIDE_SLOPE);
  // A stiffer spring in the approach, so it tracks the glide slope
  // instead of lagging high above it and dropping the last stretch.
  const land = smooth(0.5, 0.95, u);
  const omega = lerp(5, 9, land);
  b.yv += (-2 * omega * b.yv - omega * omega * (b.y - target)) * dt;
  b.y += b.yv * dt;

  // Facing where it's heading, banking into the turn.
  if (ds > 1e-5) {
    const heading = Math.atan2(dx, dz);
    const before = b.heading;
    b.heading = turn(before, heading, 9, dt);
    b.headingRate = approach(
      b.headingRate,
      wrap(b.heading - before) / dt,
      10,
      dt,
    );
  }

  // The wings follow the effort: acceleration, climbing, and the flare.
  const flare = smooth(0.8, 0.97, u);
  const demand = Math.max(
    clamp(b.accelNow / FLIGHT.accel, 0, 1),
    clamp(b.yv / 3.5, 0, 1) * 0.9,
    flare,
  );
  const burst = Math.exp(-b.t / 0.55);
  const rateTo = 7 + 11 * demand + 6 * burst;
  b.rate = approach(b.rate, rateTo, 9, dt);
  // A few glides in the cruise, when there's nothing to push for.
  const gliding =
    demand < 0.3 && Math.sin(b.t * 1.2 + b.seed * 3) > 0.3 ? 1 : 0;
  b.glide = approach(b.glide, gliding, 4, dt);
  const ampTo = (0.5 + 0.5 * demand + 0.15 * burst) * (1 - 0.9 * b.glide);
  b.amp = approach(b.amp, ampTo, 10, dt);
  b.wingPhase += b.rate * dt;
  springFold(b, 0, 14, 1, dt);

  // Nose along the climb, flared up to brake at the end.
  const climb = Math.atan2(b.yv, Math.max(b.speed, 1)) * 0.7;
  b.pose.pitch = lerp(climb, 0.55, flare);
  b.lift = 0;

  if (b.s >= dist - 1e-4) {
    b.phase = "settle";
    b.t = 0;
    b.x = b.to.x;
    b.z = b.to.z;
    b.y = b.to.y;
    b.yv = 0;
    b.speed = 0;
    // Its perch is what it'll face, after a look round.
    b.from = { ...b.to };
    b.lookTo = 0;
    b.look = wrap(b.heading - b.to.yaw);
  }
}

function settle(b: Bird, dt: number) {
  const u = clamp(b.t / FLIGHT.settle, 0, 1);
  // Braking beats die away over the first tenth of a second or so…
  const braking = 1 - smooth(0.05, 0.35, b.t);
  b.rate = approach(b.rate, 6 + 10 * braking, 14, dt);
  b.amp = approach(b.amp, 0.9 * braking, 12, dt);
  b.glide = 0;
  b.wingPhase += b.rate * dt;
  // …and the wings fold, overshooting and settling back.
  springFold(b, b.t > 0.12 ? 1 : 0.2, 22, 0.4, dt);
  // The squash of landing, and back to level.
  b.lift = -0.06 * Math.sin(clamp(b.t / 0.2, 0, 1) * Math.PI) * (1 - u * 0.5);
  b.pose.pitch = approach(b.pose.pitch, 0, 9, dt);
  b.heading = turn(b.heading, b.to.yaw, 7, dt);
  b.headingRate = approach(b.headingRate, 0, 12, dt);
  b.x = b.to.x;
  b.y = b.to.y;
  b.z = b.to.z;
  if (b.t >= FLIGHT.settle) {
    b.phase = "perched";
    b.t = 0;
    b.fold = 1;
    b.foldVel = 0;
    b.rate = 0;
    b.amp = 0;
    b.look = wrap(b.heading - b.to.yaw);
    b.lookIn = 0.8 + Math.abs(b.seed % 1) * 2;
  }
}

function writePose(b: Bird) {
  const p = b.pose;
  const fold = clamp(b.fold, -0.1, 1.12);
  // Open, a wing's shoulder follows the beat and its tip the same beat
  // a moment late, so the wing whips. A glide holds it a little up.
  const offset = 0.18 * b.glide;
  const open = wingWave(b.wingPhase) * b.amp + offset;
  const tip = wingWave(b.wingPhase - 0.14) * b.amp * 1.1 + offset;
  p.beat = lerp(open, FOLDED, fold);
  p.tip = lerp(tip, FOLDED, fold);
  p.spread = 1 - 0.65 * fold;
  p.heading = b.heading;
  p.roll =
    b.phase === "flying" || b.phase === "prep"
      ? clamp(-b.headingRate * 0.16, -0.55, 0.55)
      : 0;
  // The body rises on the downstroke and sinks on the recovery.
  const bob =
    b.phase === "flying" ? -wingWave(b.wingPhase - 0.2) * 0.035 * b.amp : 0;
  p.x = b.x;
  p.y = b.y + b.lift + bob;
  p.z = b.z;
}
