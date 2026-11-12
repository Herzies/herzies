/**
 * The weather: now and then it rains, and sometimes it storms. The same
 * for everyone, worked out from the clock alone — no server: each half
 * hour of the day (UTC) either rains or doesn't, by a hash of its number,
 * and the rain eases in over its first minutes and out over its last. The
 * pure part, tested on its own; Weather (the component) applies it.
 */

/** Whether there's weather at all. Off for now: nothing rains, no rainbow,
 * and the rain's pass isn't even in the frame (see Post). Everything that
 * reacts to rain reads `ambient.uRain`, which just stays 0. */
export const WEATHER_ON = false;

/** A half hour. */
const SLOT_MS = 30 * 60_000;
/** How many slots rain, of all of them. */
const RAIN_CHANCE = 0.08;
/** The rain comes and goes over this long at either end of a slot. */
const EASE_MS = 2.5 * 60_000;
/** Rain this heavy comes with thunder. */
const STORM_FROM = 0.85;

/** What the weather's doing at a moment. */
export type Weather = {
  /** How hard it's raining, 0–1. */
  rain: number;
  /** Whether this is a storm (lightning and thunder), while it rains. */
  storm: boolean;
};

const hash = (n: number) =>
  Math.abs(Math.sin(n * 12.9898 + 78.233) * 43758.5453) % 1;

/** How hard it would rain in a slot at its height: 0 for a dry one. */
function slotRain(slot: number): number {
  const h = hash(slot);
  if (h >= RAIN_CHANCE) return 0;
  // Light showers more often than downpours.
  const k = h / RAIN_CHANCE;
  return 0.35 + k * k * 0.65;
}

/** The weather at `now` (ms since the epoch). */
export function weatherAt(now: number): Weather {
  const slot = Math.floor(now / SLOT_MS);
  const into = now - slot * SLOT_MS;
  const peak = slotRain(slot);
  // Eased in at the start (unless the slot before rained too: then it
  // just goes on), and out at the end (unless the next one does).
  const before = slotRain(slot - 1);
  const after = slotRain(slot + 1);
  const fadeIn = before > 0 ? 1 : smooth(into / EASE_MS);
  const fadeOut = after > 0 ? 1 : smooth((SLOT_MS - into) / EASE_MS);
  const rain = peak * Math.min(fadeIn, fadeOut);
  return { rain, storm: peak >= STORM_FROM };
}

/** When the rain last stopped before `now`, in ms since the epoch, or
 * null if it's raining or hasn't rained in a day: the rainbow's cue. */
export function rainEndedAt(now: number): number | null {
  const slot = Math.floor(now / SLOT_MS);
  if (slotRain(slot) > 0) return null;
  for (let back = 1; back <= 48; back++) {
    if (slotRain(slot - back) > 0) return (slot - back + 1) * SLOT_MS;
  }
  return null;
}

function smooth(k: number): number {
  const t = Math.min(1, Math.max(0, k));
  return t * t * (3 - 2 * t);
}

/** Overrides, for looking at the weather (the sandbox, the map editor):
 * null to follow the clock. */
export const weatherOverride: { rain: number | null; storm: boolean } = {
  rain: null,
  storm: false,
};

/** The weather now, as shown. */
export function weatherNow(now = Date.now()): Weather {
  if (!WEATHER_ON) return { rain: 0, storm: false };
  if (weatherOverride.rain !== null) {
    return { rain: weatherOverride.rain, storm: weatherOverride.storm };
  }
  return weatherAt(now);
}

/** How strong the rainbow is now, 0–1: for a couple of minutes after a
 * shower, by day (the caller checks the sun). */
export function rainbowNow(now = Date.now()): number {
  if (!WEATHER_ON) return 0;
  if (weatherOverride.rain !== null) return 0;
  const ended = rainEndedAt(now);
  if (ended === null) return 0;
  const since = now - ended;
  // Up while the last drops fall, full for a while, then gone.
  const up = smooth(since / 30_000);
  const down = 1 - smooth((since - 150_000) / 60_000);
  return Math.max(0, Math.min(up, down));
}

/** The lightning: a flash every so often in a storm, each a quick bright
 * stroke that dies away. Stepped every frame by Weather; read by what
 * lights up with it. */
export const lightning = {
  /** How bright the flash is right now, 0–1. */
  flash: 0,
  /** Seconds until the next stroke. */
  next: 5,
};

/** One frame of the lightning. */
export function stepLightning(storm: boolean, rain: number, dt: number) {
  const l = lightning;
  // A stroke is a few quick flickers dying out over a third of a second.
  l.flash = Math.max(0, l.flash - dt * 4);
  if (!storm || rain < 0.5) return;
  l.next -= dt;
  if (l.next <= 0) {
    l.flash = 1;
    l.next = 6 + Math.random() * 18;
  }
}
