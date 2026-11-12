import * as THREE from "three";

/** How the world looks at one time of year. Summer is the Town as it
 * always was: every tint white, every season's extra off. */
export type SeasonLook = {
  /** Times the grass (and the ground's green): fresh in spring, ochre in
   * fall, dry in winter. */
  grass: THREE.Color;
  /** Times the leaves that turn: bushes, tall grass, the oaks. */
  leaf: THREE.Color;
  /** Times the pines' needles: they keep theirs, a little duller in the
   * cold. */
  needles: THREE.Color;
  /** Times the sun's (and the sky light's) colour: warmer in fall,
   * cooler in winter. */
  light: THREE.Color;
  /** How far the oaks have turned to reds, oranges and yellows, 0–1. */
  fall: number;
  /** How many of the oaks' leaves are gone, 0–1. */
  bare: number;
  /** How much snow lies on whatever faces up, 0–1. */
  snow: number;
  /** How frozen the ponds are, 0–1. */
  ice: number;
  /** Pink and white blossom on the oaks, 0–1. */
  blossom: number;
  /** How many leaves fall from the trees, 0–1 (summer: a few). */
  leaves: number;
  /** How hard it snows, 0–1. */
  snowfall: number;
  /** Petals drifting from the blossom, 0–1. */
  petals: number;
  /** How many butterflies by day and fireflies by night, 0–1. */
  butterflies: number;
  fireflies: number;
  /** How thick the chimney smoke is (fires lit in the cold), 0–1. */
  smoke: number;
};

type RGB = [number, number, number];
type Key = {
  day: number;
  grass: RGB;
  leaf: RGB;
  needles: RGB;
  light: RGB;
  fall: number;
  bare: number;
  snow: number;
  ice: number;
  blossom: number;
  leaves: number;
  snowfall: number;
  petals: number;
  butterflies: number;
  fireflies: number;
  smoke: number;
};

const SPRING: Omit<Key, "day"> = {
  grass: [1.08, 1.16, 0.82],
  leaf: [1.1, 1.18, 0.85],
  needles: [1, 1.04, 0.96],
  light: [1, 1, 0.98],
  fall: 0,
  bare: 0,
  snow: 0,
  ice: 0,
  blossom: 1,
  leaves: 0,
  snowfall: 0,
  petals: 1,
  butterflies: 1,
  fireflies: 0.2,
  smoke: 0.4,
};
const SUMMER: Omit<Key, "day"> = {
  grass: [1, 1, 1],
  leaf: [1, 1, 1],
  needles: [1, 1, 1],
  light: [1, 1, 1],
  fall: 0,
  bare: 0,
  snow: 0,
  ice: 0,
  blossom: 0,
  leaves: 0.25,
  snowfall: 0,
  petals: 0,
  butterflies: 1,
  fireflies: 1,
  smoke: 0.3,
};
const FALL: Omit<Key, "day"> = {
  grass: [2.5, 1.2, 0.42],
  leaf: [1.4, 0.95, 0.52],
  needles: [0.96, 0.96, 0.92],
  light: [1.05, 0.98, 0.9],
  fall: 1,
  bare: 0,
  snow: 0,
  ice: 0,
  blossom: 0,
  leaves: 1,
  snowfall: 0,
  petals: 0,
  butterflies: 0.2,
  fireflies: 0.3,
  smoke: 0.7,
};
const LATE_FALL: Omit<Key, "day"> = {
  ...FALL,
  grass: [1.9, 1.1, 0.5],
  leaf: [1.1, 0.85, 0.62],
  bare: 0.75,
  leaves: 0.35,
  butterflies: 0,
  fireflies: 0,
  smoke: 0.85,
};
const WINTER: Omit<Key, "day"> = {
  grass: [1.1, 1.02, 0.86],
  leaf: [0.95, 0.85, 0.7],
  needles: [0.84, 0.92, 0.96],
  light: [0.94, 0.97, 1.08],
  fall: 1,
  bare: 1,
  snow: 1,
  ice: 1,
  blossom: 0,
  leaves: 0,
  snowfall: 1,
  petals: 0,
  butterflies: 0,
  fireflies: 0,
  smoke: 1,
};

/** The year, keyframed by the day (northern hemisphere, wrapping round
 * the new year): each season held most of its span, blending into the
 * next over a few weeks. */
const KEYS: Key[] = [
  { day: 51, ...WINTER }, // 20 February: the thaw starts.
  { day: 95, ...SPRING }, // 5 April
  { day: 135, ...SPRING }, // 15 May
  { day: 160, ...SUMMER }, // 9 June
  { day: 240, ...SUMMER }, // 28 August
  { day: 268, ...FALL, fall: 0.5, leaves: 0.6 }, // 25 September
  { day: 290, ...FALL }, // 17 October
  { day: 305, ...FALL }, // 1 November
  { day: 314, ...LATE_FALL, snowfall: 0.15 }, // 12 November: the first flurries
  { day: 335, ...WINTER }, // 1 December: settled in
];

const YEAR = 365;

const rgb = (a: RGB, b: RGB, t: number) =>
  new THREE.Color(...a).lerp(new THREE.Color(...b), t);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Days past the start of the year (any number; wraps). */
export function seasonLook(days: number): SeasonLook {
  const d = ((days % YEAR) + YEAR) % YEAR;
  let i = KEYS.length - 1;
  while (i >= 0 && KEYS[i].day > d) i--;
  // Before the first key: still the last one's (winter), across the
  // new year.
  if (i < 0) i = KEYS.length - 1;
  const a = KEYS[i];
  const b = KEYS[(i + 1) % KEYS.length];
  const span = (b.day - a.day + YEAR) % YEAR || YEAR;
  const raw = ((d - a.day + YEAR) % YEAR) / span;
  const t = raw * raw * (3 - 2 * raw);
  return {
    grass: rgb(a.grass, b.grass, t),
    leaf: rgb(a.leaf, b.leaf, t),
    needles: rgb(a.needles, b.needles, t),
    light: rgb(a.light, b.light, t),
    fall: mix(a.fall, b.fall, t),
    bare: mix(a.bare, b.bare, t),
    snow: mix(a.snow, b.snow, t),
    ice: mix(a.ice, b.ice, t),
    blossom: mix(a.blossom, b.blossom, t),
    leaves: mix(a.leaves, b.leaves, t),
    snowfall: mix(a.snowfall, b.snowfall, t),
    petals: mix(a.petals, b.petals, t),
    butterflies: mix(a.butterflies, b.butterflies, t),
    fireflies: mix(a.fireflies, b.fireflies, t),
    smoke: mix(a.smoke, b.smoke, t),
  };
}

/** Which time of year to show: a fixed day, one read every frame (the
 * map editor's scrubber), or null for the local calendar. */
export type Season = number | (() => number) | null;

/** Days past the start of the year, here, now (0 at midnight on the 1st
 * of January). */
export function dayOfYear(now = new Date()): number {
  const start = new Date(now.getFullYear(), 0, 1);
  return (now.getTime() - start.getTime()) / 86_400_000;
}
