import * as THREE from "three";

/** How the world looks at one moment of the day. */
export type DayLook = {
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  skyBottom: THREE.Color;
  /** The hemisphere light: sky colour, ground (bounce) colour, strength. */
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  sun: THREE.Color;
  sunIntensity: number;
  /** How herzies are tinted (their shader ignores the scene's lights). */
  herzieLight: THREE.Color;
  /** 0 by day, 1 at night: fireflies, butterflies. */
  night: number;
  /** How brightly lit windows glow, 0–1. */
  windows: number;
};

type Key = {
  hour: number;
  sky: [string, string, string];
  hemi: [string, string, number];
  sun: [string, number];
  herzie: string;
  night: number;
  windows: number;
};

/** The day, keyframed by the hour (and wrapping round midnight). Dusk is
 * the look the Town had before it had a clock. */
const KEYS: Key[] = [
  {
    hour: 0,
    sky: ["#070c1e", "#22365e", "#0a1022"],
    hemi: ["#8098d0", "#3a4260", 1.3],
    sun: ["#a8bcff", 0.75],
    herzie: "#a2acd4",
    night: 1,
    windows: 1,
  },
  {
    hour: 5,
    sky: ["#09102a", "#2a3e68", "#0c1428"],
    hemi: ["#8a9ccc", "#3a4260", 1.3],
    sun: ["#b0c0ff", 0.75],
    herzie: "#a8b2d8",
    night: 1,
    windows: 0.8,
  },
  {
    hour: 6.5,
    sky: ["#2b3f78", "#f2a97a", "#5a4a6a"],
    hemi: ["#ffd9c2", "#6a5a6a", 1.4],
    sun: ["#ffc28a", 1.2],
    herzie: "#f0d8cc",
    night: 0.4,
    windows: 0.4,
  },
  {
    hour: 8.5,
    sky: ["#3f7fd6", "#a9d4f5", "#6d93c4"],
    hemi: ["#e6f2ff", "#7d8a6a", 1.9],
    sun: ["#fff4e0", 1.7],
    herzie: "#ffffff",
    night: 0,
    windows: 0,
  },
  {
    hour: 16.5,
    sky: ["#3a76cc", "#b4d6f0", "#6a8ec0"],
    hemi: ["#e6f2ff", "#7d8a6a", 1.85],
    sun: ["#fff0d8", 1.6],
    herzie: "#ffffff",
    night: 0,
    windows: 0,
  },
  {
    hour: 18.5,
    sky: ["#1d2550", "#e0806a", "#3a2f55"],
    hemi: ["#f0b8a8", "#5a5070", 1.4],
    sun: ["#ff9a6a", 1.1],
    herzie: "#f4d6cc",
    night: 0.45,
    windows: 0.7,
  },
  {
    hour: 20,
    sky: ["#0d1630", "#33507a", "#141f3a"],
    hemi: ["#bcd7ff", "#5a6684", 1.6],
    sun: ["#ffffff", 1.4],
    herzie: "#e6ecff",
    night: 0.75,
    windows: 1,
  },
  {
    hour: 22,
    sky: ["#070c1e", "#22365e", "#0a1022"],
    hemi: ["#8098d0", "#3a4260", 1.3],
    sun: ["#a8bcff", 0.75],
    herzie: "#a2acd4",
    night: 1,
    windows: 1,
  },
];

const color = (a: string, b: string, t: number) =>
  new THREE.Color(a).lerp(new THREE.Color(b), t);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** The world's look at `hours` past midnight (any number; wraps). */
export function dayLook(hours: number): DayLook {
  const h = ((hours % 24) + 24) % 24;
  let i = KEYS.length - 1;
  while (i > 0 && KEYS[i].hour > h) i--;
  const a = KEYS[i];
  const b = KEYS[(i + 1) % KEYS.length];
  const span = (b.hour - a.hour + 24) % 24 || 24;
  // Eased, so the sky doesn't change at a steady crawl.
  const raw = ((h - a.hour + 24) % 24) / span;
  const t = raw * raw * (3 - 2 * raw);
  return {
    skyTop: color(a.sky[0], b.sky[0], t),
    skyHorizon: color(a.sky[1], b.sky[1], t),
    skyBottom: color(a.sky[2], b.sky[2], t),
    hemiSky: color(a.hemi[0], b.hemi[0], t),
    hemiGround: color(a.hemi[1], b.hemi[1], t),
    hemiIntensity: mix(a.hemi[2], b.hemi[2], t),
    sun: color(a.sun[0], b.sun[0], t),
    sunIntensity: mix(a.sun[1], b.sun[1], t),
    herzieLight: color(a.herzie, b.herzie, t),
    night: mix(a.night, b.night, t),
    windows: mix(a.windows, b.windows, t),
  };
}

/** Which time of day to show: a fixed hour, one read every frame (the
 * map editor's fast-forward), or null for the local clock. */
export type Hour = number | (() => number) | null;

/** Hours past midnight, here, now. */
export function localHours(now = new Date()): number {
  return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
}
