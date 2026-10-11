import { DANCE_BEAT_FRAMES } from "../creature-renderer.js";
import { springStep } from "./companion.js";

/*
 * A floating companion's dance surges: every so often, on the beat, it's
 * lifted on a swell of the music and glides back down, rather than hopping.
 *
 * A hop is a thing with weight: it falls fastest just as it gets back to
 * where it started, and something has to stop it there — a floor. A spirit
 * has no floor and no weight; what moves it is a push and the air's drag.
 * So each surge is an authored goal (a quick smooth rise, a hang, a slower
 * glide back down) that a soft, under-damped spring follows: the spring
 * gives the follow-through — a little drift past the top, a little dip below
 * rest before it settles — and never a sudden stop. The springs are solved
 * exactly (see companion.ts), substepped so a surge is the same at any frame
 * rate.
 *
 * Surges land on the beat (the boombox's touchdowns), a few beats apart:
 * irregularly, but never long without one, nor one straight after another,
 * like the pseudo-random chances games use for procs (Dota 2's PRD).
 */

/** Seconds between the dance's beats: the old renderer's 65ms frames. */
export const BEAT_SECONDS = (DANCE_BEAT_FRAMES * 65) / 1000;

/** How a companion surges: its character. Heights in creature units. */
export type SurgeTuning = {
  /** The spring it follows its goal on (Hz, and under 1 overshoots). */
  frequency: number;
  damping: number;
  /** Seconds the goal takes to rise, and to glide back down. */
  rise: number;
  fall: number;
  /** Every surge's height, and its sideways drift, scaled by these. */
  lift: number;
  drift: number;
  /** Beats of calm between one surge ending and the next, at least and at
   * most. */
  minGap: number;
  maxGap: number;
};

/** The Greedy Spirit: buoyant and quick to the beat. */
export const SPIRIT_SURGE: SurgeTuning = {
  frequency: 1.8,
  damping: 0.5,
  rise: 0.14,
  fall: 0.5,
  lift: 1,
  drift: 1,
  minGap: 2,
  maxGap: 6,
};

/** The ghost: slower, swoopier, further. */
export const GHOST_SURGE: SurgeTuning = {
  frequency: 1.15,
  damping: 0.55,
  rise: 0.26,
  fall: 1.0,
  lift: 1.1,
  drift: 2,
  minGap: 3,
  maxGap: 7,
};

/** One swell of a surge: `at` seconds in, it rises to `height` and stays
 * `hold` seconds before gliding back. */
type Swell = { at: number; height: number; hold: number };

type Variant = {
  swells: Swell[];
  /** Sideways toward the herzie (creature units), and a glance at it
   * (radians), for as long as it's up. */
  drift: number;
  glance: number;
  /** Whole turns it twirls through on the way up. */
  spin: number;
  /** How often it's picked, against the others. */
  weight: number;
};

const VARIANTS: readonly Variant[] = [
  // A little lift.
  {
    swells: [{ at: 0, height: 0.16, hold: 0.15 }],
    drift: 0,
    glance: 0,
    spin: 0,
    weight: 0.35,
  },
  // Lifted on two beats running: it climbs.
  {
    swells: [
      { at: 0, height: 0.13, hold: 0.3 },
      { at: BEAT_SECONDS, height: 0.13, hold: 0.2 },
    ],
    drift: 0,
    glance: 0,
    spin: 0,
    weight: 0.25,
  },
  // Over toward the herzie, looking at it, and back.
  {
    swells: [{ at: 0, height: 0.18, hold: 0.3 }],
    drift: 0.14,
    glance: 0.6,
    spin: 0,
    weight: 0.25,
  },
  // The big one: high, with a twirl.
  {
    swells: [{ at: 0, height: 0.3, hold: 0.3 }],
    drift: 0,
    glance: 0,
    spin: 1,
    weight: 0.15,
  },
];

/** How many surge variants there are (indices 0..n-1). */
export const SURGE_VARIANT_COUNT = VARIANTS.length;

/** Longest a spring step is held on one goal (s). */
const SUBSTEP = 1 / 240;
/** Glance and drift follow their goals on a steadier spring. */
const SIDE_DAMPING = 0.8;
/** The twirl's spring, this many times quicker than the lift's. */
const SPIN_FREQUENCY = 1.6;
/** A frame longer than this (the view was hidden) puts it straight back. */
const MAX_DT = 1;

export type SurgeState = {
  /** How far up it is (creature units), and how fast it's rising. */
  y: number;
  v: number;
  /** How far over toward the herzie, and how fast. */
  x: number;
  xv: number;
  /** How far it's glancing toward the herzie (radians), and how fast. */
  glance: number;
  gv: number;
  /** Its twirl (radians), and how fast it's turning. */
  spin: number;
  sv: number;
  /** Its own clock (s). */
  t: number;
  /** The surge it's in, if any: when it began, and which. */
  pulse: { start: number; variant: number } | null;
  /** The beat the next surge lands on; null until the dance's first beat. */
  nextBeat: number | null;
  lastVariant: number;
  random: () => number;
};

export function newSurgeState(random: () => number): SurgeState {
  return {
    y: 0,
    v: 0,
    x: 0,
    xv: 0,
    glance: 0,
    gv: 0,
    spin: 0,
    sv: 0,
    t: 0,
    pulse: null,
    nextBeat: null,
    lastVariant: -1,
    random,
  };
}

/** 0 to 1 with no speed at either end, and no jolt (Perlin's smootherstep). */
function smootherstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** How far up a swell has its goal, `u` seconds after the surge began. */
function swellGoal(swell: Swell, u: number, tuning: SurgeTuning): number {
  const s = u - swell.at;
  if (s <= 0) return 0;
  const { rise, fall } = tuning;
  if (s < rise) return swell.height * smootherstep(s / rise);
  if (s < rise + swell.hold) return swell.height;
  return swell.height * (1 - smootherstep((s - rise - swell.hold) / fall));
}

/** How long a variant's goal is off rest (s). */
function variantLength(variant: Variant, tuning: SurgeTuning): number {
  let end = 0;
  for (const s of variant.swells) {
    end = Math.max(end, s.at + tuning.rise + s.hold + tuning.fall);
  }
  return end;
}

/** The variant picked, by weight, never the one before. */
function pickVariant(state: SurgeState): number {
  let total = 0;
  VARIANTS.forEach((v, i) => {
    if (i !== state.lastVariant) total += v.weight;
  });
  let r = state.random() * total;
  for (let i = 0; i < VARIANTS.length; i++) {
    if (i === state.lastVariant) continue;
    r -= VARIANTS[i].weight;
    if (r < 0) return i;
  }
  return VARIANTS.length - 1 === state.lastVariant ? 0 : VARIANTS.length - 1;
}

function gapBeats(state: SurgeState, tuning: SurgeTuning): number {
  const span = tuning.maxGap - tuning.minGap + 1;
  return tuning.minGap + Math.floor(state.random() * span);
}

/** Starts surge `variant` now (ahead of the schedule, if need be). */
export function startSurge(
  state: SurgeState,
  variant: number,
  tuning: SurgeTuning,
): number {
  state.pulse = { start: state.t, variant };
  state.lastVariant = variant;
  return Math.ceil(variantLength(VARIANTS[variant], tuning) / BEAT_SECONDS);
}

function onBeat(state: SurgeState, beat: number, tuning: SurgeTuning) {
  if (state.nextBeat === null) {
    // The dance just started: the first surge a beat or few in.
    state.nextBeat = beat + 1 + Math.floor(state.random() * 3);
    return;
  }
  if (beat < state.nextBeat) return;
  if (state.pulse) {
    state.nextBeat = beat + 1;
    return;
  }
  const beats = startSurge(state, pickVariant(state), tuning);
  state.nextBeat = beat + beats + gapBeats(state, tuning);
}

/** Moves it on `dt` seconds, toward its goals, with no beats. */
function advance(state: SurgeState, dt: number, tuning: SurgeTuning) {
  let left = dt;
  while (left > 1e-12) {
    const h = Math.min(left, SUBSTEP);
    let up = 0;
    let side = 0;
    let glance = 0;
    // Out of a twirl, it turns on round to the nearest whole turn.
    let spin = Math.round(state.spin / (Math.PI * 2)) * Math.PI * 2;
    const { pulse } = state;
    if (pulse) {
      const variant = VARIANTS[pulse.variant];
      const u = state.t + h / 2 - pulse.start;
      let most = 0;
      for (const s of variant.swells) {
        const g = swellGoal(s, u, tuning);
        up += g;
        most = Math.max(most, g / s.height);
      }
      up *= tuning.lift;
      side = variant.drift * tuning.drift * most;
      glance = variant.glance * most;
      // The twirl turns all the way round on the way up and into the hang.
      const twirl = tuning.rise + variant.swells[0].hold + 0.2;
      if (variant.spin)
        spin = variant.spin * Math.PI * 2 * smootherstep(u / twirl);
    }
    const { frequency, damping } = tuning;
    [state.y, state.v] = springStep(
      state.y,
      state.v,
      up,
      frequency,
      damping,
      h,
    );
    [state.x, state.xv] = springStep(
      state.x,
      state.xv,
      side,
      frequency,
      SIDE_DAMPING,
      h,
    );
    [state.glance, state.gv] = springStep(
      state.glance,
      state.gv,
      glance,
      frequency,
      SIDE_DAMPING,
      h,
    );
    [state.spin, state.sv] = springStep(
      state.spin,
      state.sv,
      spin,
      frequency * SPIN_FREQUENCY,
      SIDE_DAMPING,
      h,
    );
    state.t += h;
    left -= h;
    if (
      pulse &&
      state.t - pulse.start >= variantLength(VARIANTS[pulse.variant], tuning)
    ) {
      state.pulse = null;
    }
  }
  // Settled on a whole turn: call it none.
  const turns = Math.round(state.spin / (Math.PI * 2));
  if (
    turns !== 0 &&
    !state.pulse &&
    Math.abs(state.spin - turns * Math.PI * 2) < 1e-4 &&
    Math.abs(state.sv) < 1e-3
  ) {
    state.spin -= turns * Math.PI * 2;
  }
}

/** Back at rest, with no surge under way. */
function settle(state: SurgeState) {
  state.y = state.v = state.x = state.xv = 0;
  state.glance = state.gv = state.spin = state.sv = 0;
  state.pulse = null;
  state.nextBeat = null;
}

/**
 * Moves the surge on `dt` seconds, to `clock` seconds into the dance (0
 * when it isn't dancing). Each beat the dance passes, at its own moment in
 * the frame, may start a surge; not dancing, none does, and it glides back
 * to rest.
 */
export function stepSurge(
  state: SurgeState,
  dt: number,
  clock: number,
  dancing: boolean,
  tuning: SurgeTuning,
): void {
  if (dt <= 0) return;
  if (dt > MAX_DT) {
    settle(state);
    return;
  }
  let done = 0;
  if (dancing) {
    const from = clock - dt;
    for (
      let beat = Math.floor(from / BEAT_SECONDS + 1e-9) + 1;
      beat * BEAT_SECONDS <= clock + 1e-9;
      beat++
    ) {
      const at = Math.max(0, beat * BEAT_SECONDS - from);
      advance(state, at - done, tuning);
      done = at;
      onBeat(state, beat, tuning);
    }
  } else {
    // A surge under way lets go: it glides back from wherever it is.
    state.pulse = null;
    state.nextBeat = null;
  }
  advance(state, dt - done, tuning);
}
