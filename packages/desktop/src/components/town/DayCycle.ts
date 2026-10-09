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
  /** How herzies are tinted (their shader ignores the scene's lights):
   * the keyframes' colour, as bright as the scene's own light (see
   * sceneLight), so they never stand out lit against a dark world. */
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
    sky: ["#02040a", "#0b1226", "#03050b"],
    hemi: ["#4a5888", "#12152a", 0.22],
    sun: ["#9fb2ff", 0.2],
    herzie: "#262c44",
    night: 1,
    windows: 1,
  },
  {
    hour: 5,
    sky: ["#040816", "#16223e", "#050914"],
    hemi: ["#5a6aa0", "#1a1e34", 0.35],
    sun: ["#a8baff", 0.24],
    herzie: "#343c5a",
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
    sky: ["#02040a", "#0b1226", "#03050b"],
    hemi: ["#4a5888", "#12152a", 0.22],
    sun: ["#9fb2ff", 0.2],
    herzie: "#262c44",
    night: 1,
    windows: 1,
  },
];

const color = (a: string, b: string, t: number) =>
  new THREE.Color(a).lerp(new THREE.Color(b), t);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

const luminance = (c: THREE.Color) =>
  0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** A colour at full strength: just its hue. */
function tint(c: THREE.Color): THREE.Color {
  const top = Math.max(c.r, c.g, c.b, 1e-6);
  return c.multiplyScalar(1 / top);
}

/** How much light the scene's lights give at an hour: the sky's (the
 * hemisphere) and the sun's or moon's, as far as it's up. */
function sceneLight(
  hours: number,
  hemi: number,
  hemiSky: THREE.Color,
  sun: number,
  sunColor: THREE.Color,
): number {
  return (
    hemi * luminance(hemiSky) +
    sun * skyLights(hours).strength * luminance(sunColor)
  );
}

/** The scene's light at noon: herzies at full brightness. (Worked out
 * on first use: skyLights' constants come later in the file.) */
let noonLight = 0;
function atNoon(): number {
  if (!noonLight) {
    const noon = KEYS.find((k) => k.hour === 8.5) as Key;
    noonLight = sceneLight(
      12,
      noon.hemi[2],
      new THREE.Color(noon.hemi[0]),
      noon.sun[1],
      new THREE.Color(noon.sun[0]),
    );
  }
  return noonLight;
}

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
    herzieLight: tint(color(a.herzie, b.herzie, t)).multiplyScalar(
      Math.min(
        1,
        sceneLight(
          h,
          mix(a.hemi[2], b.hemi[2], t),
          color(a.hemi[0], b.hemi[0], t),
          mix(a.sun[1], b.sun[1], t),
          color(a.sun[0], b.sun[0], t),
        ) / atNoon(),
      ),
    ),
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

/** When the sun crosses the horizon, in hours past midnight (the dawn and
 * dusk keys above). */
export const SUNRISE = 6.5;
export const SUNSET = 18.5;
/** How high the sun gets at noon. */
const NOON_ELEVATION = (55 * Math.PI) / 180;
/** How high the moon gets at midnight: low, so it's in view under the
 * Town's camera, which never looks far above the horizon. (Its light still
 * comes from the sun's opposite, higher up, so shadows stay short.) */
const MOON_ELEVATION = (13 * Math.PI) / 180;
/** The light never comes in lower than this: grazing light stretches
 * shadows across the whole island. */
const MIN_LIGHT_ELEVATION = (12 * Math.PI) / 180;
/** The herzies' own light stays between these, so they neither wash out
 * at noon nor go dark at dusk (their bands were tuned for a mid sun). */
const HERZIE_ELEVATION = [(25 * Math.PI) / 180, (60 * Math.PI) / 180];

/** Where the sun and moon are, and where the light comes from. */
export type SkyLights = {
  /** Towards the sun (unit; below the horizon at night). */
  sun: THREE.Vector3;
  /** Towards the moon: opposite the sun's bearing, on a lower arc. */
  moon: THREE.Vector3;
  /** Towards whichever is up, never lower than MIN_LIGHT_ELEVATION. */
  light: THREE.Vector3;
  /** How much of the directional light, and its shadows, to use (0–1):
   * none with the sun or moon on the horizon, where the light switches
   * from one to the other. */
  strength: number;
  /** The herzies' light: `light`, held to a mid height. */
  herzie: THREE.Vector3;
};

/** Turns `dir` (unit) to the given elevation, keeping its bearing. */
function atElevation(dir: THREE.Vector3, elevation: number): THREE.Vector3 {
  const flat = Math.hypot(dir.x, dir.z) || 1;
  const c = Math.cos(elevation);
  return new THREE.Vector3(
    (dir.x / flat) * c,
    Math.sin(elevation),
    (dir.z / flat) * c,
  );
}

/**
 * The sky's lights at `hours` past midnight: the sun rises in the east
 * (+x) at SUNRISE, climbs to NOON_ELEVATION over the south (+z) and sets
 * in the west at SUNSET — one circle a day, so the moon (opposite) does
 * the same by night.
 */
export function skyLights(hours: number): SkyLights {
  const h = ((hours % 24) + 24) % 24;
  const a = (Math.PI * (h - SUNRISE)) / (SUNSET - SUNRISE);
  const sun = new THREE.Vector3(
    Math.cos(a),
    Math.sin(a) * Math.sin(NOON_ELEVATION),
    Math.sin(a) * Math.cos(NOON_ELEVATION),
  );
  const opposite = sun.clone().negate();
  const moon = atElevation(
    opposite,
    Math.asin(THREE.MathUtils.clamp(opposite.y, -1, 1)) *
      (MOON_ELEVATION / NOON_ELEVATION),
  );
  const up = sun.y >= 0 ? sun : opposite;
  const elevation = Math.asin(THREE.MathUtils.clamp(up.y, -1, 1));
  const light = atElevation(up, Math.max(elevation, MIN_LIGHT_ELEVATION));
  const herzie = atElevation(
    up,
    THREE.MathUtils.clamp(elevation, HERZIE_ELEVATION[0], HERZIE_ELEVATION[1]),
  );
  const strength = THREE.MathUtils.smoothstep(up.y, 0.02, 0.2);
  return { sun, moon, light, strength, herzie };
}
