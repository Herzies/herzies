/**
 * The ship's bell, rung: when its strikes fall and how a bell moves as
 * it's rung. One pattern for the ear and the eye — the sound (sfxShipBell)
 * and the bells you see (AirshipModel's on deck, DockModel's on the pier)
 * both read their strikes from `bellStrikeAt`, and the bells are posed
 * from the seconds since the sound started, on the fleet's clock
 * (shipSounds records when it rang), so every chime lands as the clapper
 * meets the rim.
 *
 * A ship's bell is rung by its lanyard, in pairs: the clapper is jerked
 * out to the rim — ding — and falls back, the bell kicked into a little
 * swing by each blow; ding-ding, a breath, ding-ding.
 */

/** Seconds between the two strikes of a pair, and from a pair's second
 * strike to the next pair's first. */
const PAIR = 0.34;
const BETWEEN_PAIRS = 0.8;

/** When strike `i` (from 0) of a ringing falls, s after the first. */
export function bellStrikeAt(i: number): number {
  return Math.floor(i / 2) * (PAIR + BETWEEN_PAIRS) + (i % 2) * PAIR;
}

/** How far the clapper swings in the bell (rad) before its ball meets
 * the rim — bellGeometry's lathe, its pivot at the crown. */
export const CLAPPER_HIT = 0.55;

/** The bell's kick per blow (rad; more than a real bell gives, to read
 * from the dock), how fast it dies away (1/s), and its swing (Hz): half a
 * swing to a pair, so the second blow finds it back at the plumb and each
 * pair kicks it the same way. */
const KICK = 0.28;
const BELL_DAMP = 1.6;
const BELL_HZ = 1 / (2 * PAIR);
/** The lanyard's pull, s: the clapper drawn out to the rim before each
 * blow after the first (the first is the moment the sound starts, so it
 * can only snap out); then its rebound off the rim — flung past it, held
 * there by the clamp for a frame or two, falling back through the plumb
 * and settling. */
const PULL = 0.07;
const CLAP_OVER = 1.3;
const CLAP_DAMP = 7;
const CLAP_HZ = 2.4;
/** How much the hanging clapper lags the bell's own swing. */
const CLAP_LAG = 0.5;
/** Past the last strike by this long (s), both are still. */
const STILL = 6;

/** A bell's pose, rad about its yoke: the bell's swing, and the clapper's
 * inside it (±CLAPPER_HIT at the rim). */
export type BellPose = { swing: number; clapper: number };

/** Pose a bell `since` seconds after it began ringing `strikes` times
 * (negative, NaN or Infinity: hanging still), into `out`. */
export function poseBell(
  since: number,
  strikes: number,
  out: BellPose,
): BellPose {
  out.swing = 0;
  out.clapper = 0;
  if (!(since >= 0) || since > bellStrikeAt(strikes - 1) + STILL) return out;
  let swing = 0;
  let clap = 0;
  for (let i = 0; i < strikes; i++) {
    const tau = since - bellStrikeAt(i);
    if (tau >= 0) {
      swing +=
        KICK *
        Math.exp(-BELL_DAMP * tau) *
        Math.sin(2 * Math.PI * BELL_HZ * tau);
      clap +=
        CLAP_OVER *
        CLAPPER_HIT *
        Math.exp(-CLAP_DAMP * tau) *
        Math.cos(2 * Math.PI * CLAP_HZ * tau);
    } else if (tau > -PULL) {
      const x = 1 + tau / PULL;
      clap += CLAPPER_HIT * x * x * (3 - 2 * x);
    }
  }
  out.swing = swing;
  out.clapper = Math.min(
    CLAPPER_HIT,
    Math.max(-CLAPPER_HIT, clap - CLAP_LAG * swing),
  );
  return out;
}
