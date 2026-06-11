/**
 * Procedural 3D ASCII creature renderer.
 *
 * Each creature is a composition of sphere primitives, rendered via
 * ray-sphere intersection with the same ASCII shading as items.ts.
 * Creatures are deterministically generated from a user ID string.
 *
 * Coordinate system: camera at (0, 0, -CAM) looking toward +Z.
 * Negative Z = toward camera. Y-up is negative (screen convention).
 */

import {
  CHAR_ASPECT,
  dot3,
  LIGHT,
  RAMP_HERZIE,
  rotY,
  type V3,
} from "./ascii3d.js";

// --- Creature viewport ---
const SW = 80;
const SH = 48;
const CAM = 2.0;
const FOV_Y = 1.8;
const HALF_H = Math.tan(FOV_Y / 2);

/** Horizontal half-extent of the view plane for a given column count. */
function halfWidthFor(cols: number): number {
  return HALF_H * ((cols / SH) * (1 / CHAR_ASPECT));
}

const HALF_W = halfWidthFor(SW);
const TILT = 8 * (Math.PI / 180);
const TILT_COS = Math.cos(TILT);
const TILT_SIN = Math.sin(TILT);

// Default viewing angle — slightly off front-facing
export const DEFAULT_Y_ANGLE = 17 * (Math.PI / 180);

// Creature scale
const CS = 1.5;

export const CREATURE_PALETTE = [
  "#FFD700", // amber (original)
  "#FF6B6B", // coral red
  "#4ECDC4", // teal
  "#A8E6CF", // sage green
  "#C3A6FF", // soft violet
  "#FF9F43", // warm orange
  "#74B9FF", // sky blue
  "#FD79A8", // rose pink
  "#55EFC4", // mint
  "#FDCB6E", // golden yellow
];

const EYE_COLOR = "#FFF8DC";

// --- HSL color utilities ---

interface ColorTriplet {
  dim: string;
  base: string;
  bright: string;
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  if (s === 0) {
    const v = Math.round(l * 255);
    return `#${v.toString(16).padStart(2, "0").repeat(3)}`.toUpperCase();
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const g = Math.round(hue2rgb(p, q, h) * 255);
  const b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
}

const RAINBOW_HEADBAND = [
  "#FF6B6B",
  "#FFA94D",
  "#FFD43B",
  "#69DB7C",
  "#4DABF7",
  "#9775FA",
  "#F783AC",
] as const;

function shadeWearableColor(hex: string, brightness: number): string {
  const [h, s, l] = hexToHsl(hex);
  if (brightness > 0.6)
    return hslToHex(h, s, Math.min(0.88, l + (1 - l) * 0.4));
  if (brightness > 0.3) return hex.toUpperCase();
  return hslToHex(h, s, l * 0.55);
}

function buildColorTriplet(hex: string): ColorTriplet {
  const [h, s, l] = hexToHsl(hex);
  // Dim: darken while keeping saturation punchy
  const dimL = l * 0.45;
  const dimS = s;
  // Bright: lighten moderately, preserve saturation
  const brightL = Math.min(0.82, l + (1 - l) * 0.45);
  const brightS = s;
  return {
    dim: hslToHex(h, dimS, dimL),
    base: hex.toUpperCase(),
    bright: hslToHex(h, brightS, brightL),
  };
}

// --- Idle animation constants ---
// Amplitudes in world units, applied to already-scaled sphere positions.
// Tuned so motion is ~0.3-0.5 pixels — visible but slow and organic.
const IDLE_FRAMES = 60;
const IDLE_INTERVAL = 50; // ms per frame
const IDLE_TOTAL_MS = IDLE_FRAMES * IDLE_INTERVAL; // 3000ms loop

const IDLE = {
  body: { amp: 0.04, period: 2000 },
  head: { amp: 0.025, period: 2500 },
  eye: { amp: 0.025, period: 2500 }, // follows head
  limb: { amp: 0.03, period: 1800 },
  ear: { amp: 0.02, period: 2200 },
  spike: { amp: 0.015, period: 2200 }, // follows ears
} as const;

// --- Dance animation constants ---
// Energetic rhythmic motion — ~2.5-3× idle amplitudes, faster cycle.
const DANCE_FRAMES = 24;
const DANCE_INTERVAL = 65; // ms per frame → 1560ms loop (~77 BPM)

const DANCE = {
  body: { amp: 0.11, cycles: 2 },
  head: { amp: 0.07, cycles: 2 }, // phase π/3 — nods slightly behind body
  eye: { amp: 0.07, cycles: 2 }, // follows head
  limb: { amp: 0.09, cycles: 2 }, // L at 0, R at π — alternating sway
  ear: { amp: 0.055, cycles: 4 }, // double body freq — floppy
  spike: { amp: 0.04, cycles: 4, xAmp: 0.03, xCycles: 2 }, // Y bounce + lateral X sway
} as const;

// --- Seeded PRNG ---

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rangeSeeded(min: number, max: number, rng: () => number): number {
  return min + rng() * (max - min);
}

function intSeeded(min: number, max: number, rng: () => number): number {
  return Math.floor(rangeSeeded(min, max + 1, rng));
}

// --- Sphere primitives ---

type ColorZone = "primary" | "accent" | "eye" | "pupil" | "dark" | "wearable";

interface Sphere {
  center: V3;
  radius: number;
  zone: ColorZone;
  part: string;
  /** Fixed color for wearables (shaded by lighting at render time). */
  color?: string;
}

// --- Dance animation offsets ---
// Returns a copy of the sphere list with per-part dance offsets applied.
// Adds X-axis sway for spikes in addition to Y-axis bounce.

function applyDanceOffsets(spheres: Sphere[], frameIdx: number): Sphere[] {
  const t = frameIdx / DANCE_FRAMES; // normalized 0..1

  function yOff(amp: number, cycles: number, phase: number): number {
    return Math.sin(2 * Math.PI * t * cycles + phase) * amp;
  }

  const bodyOff = yOff(DANCE.body.amp, DANCE.body.cycles, 0);
  const headOff = yOff(DANCE.head.amp, DANCE.head.cycles, Math.PI / 3);
  const eyeOff = headOff;
  const earOff = yOff(DANCE.ear.amp, DANCE.ear.cycles, Math.PI / 6);
  const spikeYOff = yOff(DANCE.spike.amp, DANCE.spike.cycles, Math.PI / 4);
  const spikeXOff =
    Math.sin(2 * Math.PI * t * DANCE.spike.xCycles + Math.PI / 4) *
    DANCE.spike.xAmp;
  const limbLOff = yOff(DANCE.limb.amp, DANCE.limb.cycles, 0);
  const limbROff = yOff(DANCE.limb.amp, DANCE.limb.cycles, Math.PI);

  return spheres.map((s) => {
    let dy = 0;
    let dx = 0;
    if (s.part === "body") dy = bodyOff;
    else if (s.part === "head") dy = headOff;
    else if (s.part === "eye" || s.part === "pupil") dy = eyeOff;
    else if (s.part === "ear") dy = earOff;
    else if (s.part === "spike") {
      dy = spikeYOff;
      dx = spikeXOff;
    } else if (s.part === "arm-l" || s.part === "leg-l") dy = limbLOff;
    else if (s.part === "arm-r" || s.part === "leg-r") dy = limbROff;

    return {
      ...s,
      center: [s.center[0] + dx, s.center[1] + dy, s.center[2]] as V3,
    };
  });
}

// --- Anchor points ---

export interface AnchorPoint {
  name: string;
  localOffset: V3;
  parentPart: string;
  normalDir: V3;
}

export interface FrameAnchor {
  screenX: number;
  screenY: number;
  visible: boolean;
  depth: number;
  /** Projected radius of the parent sphere in screen (cell) units. */
  screenRadius: number;
}

export interface Cell {
  ch: string;
  color: string;
}

export interface FrameData {
  cells: Cell[][];
  anchors: Record<string, FrameAnchor>;
}

export { mulberry32, SH, SW, simpleHash };

// --- Creature parameters ---

export interface CreatureParams {
  bodyType: number;
  colorIndex: number;
  bodyScale: number;
  headRatio: number;
  eyeSpacing: number;
  eyeSize: number;
  eyeHeight: number;
  earCount: number;
  earAngle: number;
  earLength: number;
  armLength: number;
  legLength: number;
  textureType: number;
}

export const CREATURE_BODY_TYPES = ["blob", "tall", "wide", "spiky"] as const;

export const CREATURE_PARAM_BOUNDS = {
  bodyType: { min: 0, max: 3, step: 1 },
  colorIndex: { min: 0, max: CREATURE_PALETTE.length - 1, step: 1 },
  bodyScale: { min: 0.85, max: 1.05, step: 0.01 },
  headRatio: { min: 0.65, max: 0.85, step: 0.01 },
  eyeSpacing: { min: 0.1, max: 0.18, step: 0.005 },
  eyeSize: { min: 0.09, max: 0.15, step: 0.005 },
  eyeHeight: { min: -0.25, max: -0.1, step: 0.005 },
  earCount: { min: 0, max: 2, step: 1 },
  earAngleDeg: { min: 25, max: 70, step: 1 },
  earLength: { min: 0.12, max: 0.28, step: 0.01 },
  armLength: { min: 0.25, max: 0.45, step: 0.01 },
  legLength: { min: 0.3, max: 0.55, step: 0.01 },
  textureType: { min: 0, max: 3, step: 1 },
} as const;

export function earAngleToDeg(rad: number): number {
  return Math.round((rad * 180) / Math.PI);
}

export function earAngleFromDeg(deg: number): number {
  return deg * (Math.PI / 180);
}

function resolveCreatureParams(
  userId: string,
  params?: CreatureParams,
): CreatureParams {
  return params ?? generateCreatureParams(userId);
}

function paramsCacheKey(userId: string, params?: CreatureParams): string {
  return params ? `${userId}:${JSON.stringify(params)}` : userId;
}

export function generateCreatureParams(userId: string): CreatureParams {
  const seed = simpleHash(userId);
  const rng = mulberry32(seed);

  return {
    bodyType: intSeeded(0, 3, rng),
    colorIndex: intSeeded(0, CREATURE_PALETTE.length - 1, rng),
    bodyScale: rangeSeeded(
      CREATURE_PARAM_BOUNDS.bodyScale.min,
      CREATURE_PARAM_BOUNDS.bodyScale.max,
      rng,
    ),
    headRatio: rangeSeeded(
      CREATURE_PARAM_BOUNDS.headRatio.min,
      CREATURE_PARAM_BOUNDS.headRatio.max,
      rng,
    ),
    eyeSpacing: rangeSeeded(0.1, 0.18, rng),
    eyeSize: rangeSeeded(0.09, 0.15, rng),
    eyeHeight: rangeSeeded(-0.25, -0.1, rng),
    earCount: intSeeded(0, 2, rng),
    earAngle: rangeSeeded(25, 70, rng) * (Math.PI / 180),
    earLength: rangeSeeded(0.12, 0.28, rng),
    armLength: rangeSeeded(0.25, 0.45, rng),
    legLength: rangeSeeded(0.3, 0.55, rng),
    textureType: intSeeded(0, 3, rng),
  };
}

// --- Helper: compute eye Z so eyes protrude from head surface ---

function eyeZ(headR: number, eyeX: number, eyeY: number, eyeR: number): number {
  const headSurfaceZ = Math.sqrt(
    Math.max(0, headR * headR - eyeX * eyeX - eyeY * eyeY),
  );
  return -(headSurfaceZ - eyeR * 0.3);
}

// --- Pupil geometry helper ---
// Places a small dark sphere on the front face of an eye sphere.

function addPupils(
  spheres: Sphere[],
  eyeRadius: number,
  leftCenter: V3,
  rightCenter: V3,
): void {
  const pr = eyeRadius * 0.32;
  const zOff = -eyeRadius * 0.85; // protrude toward camera
  spheres.push({
    center: [leftCenter[0], leftCenter[1], leftCenter[2] + zOff],
    radius: pr,
    zone: "pupil",
    part: "pupil",
  });
  spheres.push({
    center: [rightCenter[0], rightCenter[1], rightCenter[2] + zOff],
    radius: pr,
    zone: "pupil",
    part: "pupil",
  });
}

// --- Vertical centering ---
// Compute bounding box and shift all sphere centers so the creature
// is vertically centered at y=0 in world space.

function centerVertically(spheres: Sphere[]): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of spheres) {
    minY = Math.min(minY, s.center[1] - s.radius);
    maxY = Math.max(maxY, s.center[1] + s.radius);
  }
  const midY = (minY + maxY) / 2;
  for (const s of spheres) {
    s.center = [s.center[0], s.center[1] - midY, s.center[2]];
  }
}

// --- Body archetype builders ---

function buildBlob(p: CreatureParams, stage: number): Sphere[] {
  const s = p.bodyScale * CS;
  const spheres: Sphere[] = [];

  const headR = 0.65 * p.headRatio * s;
  // Head pushed up further from body for clear silhouette separation
  const headY = stage === 1 ? 0 : stage === 2 ? -0.55 * s : -0.45 * s;
  spheres.push({
    center: [0, headY, 0],
    radius: headR,
    zone: "primary",
    part: "head",
  });

  const ex = p.eyeSpacing * s;
  const ey = headY + p.eyeHeight * headR * 1.6;
  const er = p.eyeSize * s;
  const ez = eyeZ(headR, ex, ey - headY, er);
  spheres.push({ center: [-ex, ey, ez], radius: er, zone: "eye", part: "eye" });
  spheres.push({ center: [ex, ey, ez], radius: er, zone: "eye", part: "eye" });
  addPupils(spheres, er, [-ex, ey, ez], [ex, ey, ez]);

  for (let i = 0; i < p.earCount; i++) {
    const side = p.earCount === 1 ? 0 : i === 0 ? -1 : 1;
    const earX = side * 0.2 * s;
    const earY = headY - headR * 0.95;
    spheres.push({
      center: [earX, earY - Math.cos(p.earAngle) * p.earLength * s, 0],
      radius: p.earLength * 0.4 * s,
      zone: "accent",
      part: "ear",
    });
  }

  if (stage >= 2) {
    const armY = stage === 3 ? 0.1 * s : headY + headR * 0.4;
    const armX = stage === 3 ? 0.55 * s : headR + 0.12 * s;
    spheres.push({
      center: [-armX, armY, 0],
      radius: 0.18 * s,
      zone: "primary",
      part: "arm-l",
    });
    spheres.push({
      center: [armX, armY, 0],
      radius: 0.18 * s,
      zone: "primary",
      part: "arm-r",
    });
  }

  if (stage >= 3) {
    const bodyR = 0.55 * s;
    spheres.push({
      center: [0, 0.25 * s, 0],
      radius: bodyR,
      zone: "primary",
      part: "body",
    });
    // Neck sphere bridging head and body
    const neckY = (headY + 0.25 * s) * 0.5;
    spheres.push({
      center: [0, neckY, 0],
      radius: 0.3 * s,
      zone: "primary",
      part: "body",
    });

    const legY = 0.25 * s + bodyR * 0.75;
    const legX = 0.25 * s;
    spheres.push({
      center: [-legX, legY, 0],
      radius: 0.2 * s,
      zone: "accent",
      part: "leg-l",
    });
    spheres.push({
      center: [legX, legY, 0],
      radius: 0.2 * s,
      zone: "accent",
      part: "leg-r",
    });
    spheres.push({
      center: [-legX, legY + p.legLength * 0.5 * s, 0],
      radius: 0.16 * s,
      zone: "accent",
      part: "leg-l",
    });
    spheres.push({
      center: [legX, legY + p.legLength * 0.5 * s, 0],
      radius: 0.16 * s,
      zone: "accent",
      part: "leg-r",
    });
  }

  return spheres;
}

function buildTall(p: CreatureParams, stage: number): Sphere[] {
  const s = p.bodyScale * CS;
  const spheres: Sphere[] = [];

  const headR = 0.5 * p.headRatio * s;
  const headY = stage === 1 ? 0 : stage === 2 ? -0.65 * s : -0.55 * s;
  spheres.push({
    center: [0, headY, 0],
    radius: headR,
    zone: "primary",
    part: "head",
  });
  spheres.push({
    center: [0, headY - headR * 0.25, 0],
    radius: headR * 0.92,
    zone: "primary",
    part: "head",
  });

  const ex = p.eyeSpacing * s * 0.9;
  const ey = headY + p.eyeHeight * headR * 1.5;
  const er = p.eyeSize * s * 0.9;
  const ez = eyeZ(headR, ex, ey - headY, er);
  spheres.push({ center: [-ex, ey, ez], radius: er, zone: "eye", part: "eye" });
  spheres.push({ center: [ex, ey, ez], radius: er, zone: "eye", part: "eye" });
  addPupils(spheres, er, [-ex, ey, ez], [ex, ey, ez]);

  for (let i = 0; i < p.earCount; i++) {
    const side = p.earCount === 1 ? 0 : i === 0 ? -1 : 1;
    const earX = side * 0.2 * s;
    const earY = headY - headR;
    spheres.push({
      center: [earX, earY - p.earLength * s * 0.8, 0],
      radius: p.earLength * 0.35 * s,
      zone: "accent",
      part: "ear",
    });
  }

  if (stage >= 2) {
    const armY = stage === 3 ? -0.05 * s : -0.15 * s;
    // Stage 3 body is wider, so push arms further out to stay visible
    const armX = stage === 3 ? 0.47 * s : 0.4 * s;
    spheres.push({
      center: [-armX, armY, 0],
      radius: 0.12 * s,
      zone: "primary",
      part: "arm-l",
    });
    spheres.push({
      center: [armX, armY, 0],
      radius: 0.12 * s,
      zone: "primary",
      part: "arm-r",
    });
    spheres.push({
      center: [-(armX + 0.1 * s), armY + p.armLength * 0.4 * s, 0],
      radius: 0.09 * s,
      zone: "primary",
      part: "arm-l",
    });
    spheres.push({
      center: [armX + 0.1 * s, armY + p.armLength * 0.4 * s, 0],
      radius: 0.09 * s,
      zone: "primary",
      part: "arm-r",
    });
  }

  if (stage >= 3) {
    // Single elongated body blob — two near-equal spheres packed tightly
    // so the silhouette reads as one capsule, not separate lumps.
    // The top sphere overlaps the head directly, forming a natural neck
    // pinch without a dedicated (bulging) neck sphere.
    spheres.push({
      center: [0, 0.05 * s, 0],
      radius: 0.4 * s,
      zone: "primary",
      part: "body",
    });
    spheres.push({
      center: [0, 0.3 * s, 0],
      radius: 0.36 * s,
      zone: "primary",
      part: "body",
    });

    const legBase = 0.62 * s;
    spheres.push({
      center: [-0.15 * s, legBase, 0],
      radius: 0.14 * s,
      zone: "accent",
      part: "leg-l",
    });
    spheres.push({
      center: [0.15 * s, legBase, 0],
      radius: 0.14 * s,
      zone: "accent",
      part: "leg-r",
    });
    spheres.push({
      center: [-0.15 * s, legBase + p.legLength * 0.6 * s, 0],
      radius: 0.11 * s,
      zone: "accent",
      part: "leg-l",
    });
    spheres.push({
      center: [0.15 * s, legBase + p.legLength * 0.6 * s, 0],
      radius: 0.11 * s,
      zone: "accent",
      part: "leg-r",
    });
  }

  return spheres;
}

/** Single wide head/body — no side-by-side blobs (breaks wearables). */
function buildWide(p: CreatureParams, stage: number): Sphere[] {
  const s = p.bodyScale * CS;
  const spheres: Sphere[] = [];

  const headR = 0.78 * p.headRatio * s;
  const headY = stage === 1 ? 0 : stage === 2 ? -0.4 * s : -0.35 * s;
  spheres.push({
    center: [0, headY, 0],
    radius: headR,
    zone: "primary",
    part: "head",
  });

  const ex = p.eyeSpacing * s * 1.15;
  const ey = headY + p.eyeHeight * headR * 1.35;
  const er = p.eyeSize * s;
  const ez = eyeZ(headR, ex, ey - headY, er);
  spheres.push({ center: [-ex, ey, ez], radius: er, zone: "eye", part: "eye" });
  spheres.push({ center: [ex, ey, ez], radius: er, zone: "eye", part: "eye" });
  addPupils(spheres, er, [-ex, ey, ez], [ex, ey, ez]);

  for (let i = 0; i < p.earCount; i++) {
    const side = p.earCount === 1 ? 0 : i === 0 ? -1 : 1;
    const earX = side * (headR + p.earLength * 0.15 * s);
    spheres.push({
      center: [earX, headY - headR * 0.75, 0],
      radius: p.earLength * 0.4 * s,
      zone: "accent",
      part: "ear",
    });
  }

  if (stage >= 2) {
    const armY = stage === 3 ? 0.1 * s : headY + headR * 0.35;
    const armX = headR + 0.12 * s;
    spheres.push({
      center: [-armX, armY, 0],
      radius: 0.17 * s,
      zone: "primary",
      part: "arm-l",
    });
    spheres.push({
      center: [armX, armY, 0],
      radius: 0.17 * s,
      zone: "primary",
      part: "arm-r",
    });
  }

  if (stage >= 3) {
    const bodyR = 0.5 * s;
    const bodyY = 0.18 * s;
    const neckY = (headY + bodyY) * 0.5;
    spheres.push({
      center: [0, neckY, 0],
      radius: 0.3 * s,
      zone: "primary",
      part: "body",
    });
    spheres.push({
      center: [0, bodyY, 0],
      radius: bodyR,
      zone: "primary",
      part: "body",
    });

    const legY = bodyY + bodyR * 0.75;
    const legX = 0.32 * s;
    spheres.push({
      center: [-legX, legY, 0],
      radius: 0.19 * s,
      zone: "accent",
      part: "leg-l",
    });
    spheres.push({
      center: [legX, legY, 0],
      radius: 0.19 * s,
      zone: "accent",
      part: "leg-r",
    });
    spheres.push({
      center: [-legX, legY + p.legLength * 0.4 * s, 0],
      radius: 0.15 * s,
      zone: "accent",
      part: "leg-l",
    });
    spheres.push({
      center: [legX, legY + p.legLength * 0.4 * s, 0],
      radius: 0.15 * s,
      zone: "accent",
      part: "leg-r",
    });
  }

  return spheres;
}

function buildSpiky(p: CreatureParams, stage: number): Sphere[] {
  const s = p.bodyScale * CS;
  const spheres: Sphere[] = [];

  const headR = 0.55 * p.headRatio * s;
  const headY = stage === 1 ? 0 : stage === 2 ? -0.5 * s : -0.4 * s;
  spheres.push({
    center: [0, headY, 0],
    radius: headR,
    zone: "primary",
    part: "head",
  });

  const ex = p.eyeSpacing * s;
  const ey = headY + p.eyeHeight * headR * 1.6;
  const er = p.eyeSize * s;
  const ez = eyeZ(headR, ex, ey - headY, er);
  spheres.push({ center: [-ex, ey, ez], radius: er, zone: "eye", part: "eye" });
  spheres.push({ center: [ex, ey, ez], radius: er, zone: "eye", part: "eye" });
  addPupils(spheres, er, [-ex, ey, ez], [ex, ey, ez]);

  const spikeCount = 2 + p.earCount;
  const spikeR = p.earLength * 0.3 * s;
  for (let i = 0; i < spikeCount; i++) {
    const angle = (i / spikeCount) * Math.PI - Math.PI / 2 + p.earAngle * 0.3;
    const sx = Math.sin(angle) * (headR + spikeR * 1.2);
    const sy = headY - Math.cos(angle) * (headR + spikeR * 1.2);
    spheres.push({
      center: [sx, sy, 0],
      radius: spikeR,
      zone: "accent",
      part: "spike",
    });
  }

  if (p.earCount > 0) {
    spheres.push({
      center: [0, headY - headR - p.earLength * s * 0.6, 0],
      radius: p.earLength * 0.35 * s,
      zone: "accent",
      part: "ear",
    });
  }

  if (stage >= 2) {
    const armY = stage === 3 ? 0.05 * s : headY + headR * 0.5;
    spheres.push({
      center: [-0.5 * s, armY, 0],
      radius: 0.14 * s,
      zone: "primary",
      part: "arm-l",
    });
    spheres.push({
      center: [0.5 * s, armY, 0],
      radius: 0.14 * s,
      zone: "primary",
      part: "arm-r",
    });
    spheres.push({
      center: [-0.62 * s, armY, 0],
      radius: 0.07 * s,
      zone: "accent",
      part: "spike",
    });
    spheres.push({
      center: [0.62 * s, armY, 0],
      radius: 0.07 * s,
      zone: "accent",
      part: "spike",
    });
  }

  if (stage >= 3) {
    // Neck sphere bridging head and body
    const neckY = (headY + 0.2 * s) * 0.5;
    spheres.push({
      center: [0, neckY, 0],
      radius: 0.3 * s,
      zone: "primary",
      part: "body",
    });
    spheres.push({
      center: [0, 0.2 * s, 0],
      radius: 0.48 * s,
      zone: "primary",
      part: "body",
    });
    spheres.push({
      center: [-0.55 * s, 0.15 * s, 0],
      radius: 0.09 * s,
      zone: "accent",
      part: "spike",
    });
    spheres.push({
      center: [0.55 * s, 0.15 * s, 0],
      radius: 0.09 * s,
      zone: "accent",
      part: "spike",
    });

    const legY = 0.6 * s;
    spheres.push({
      center: [-0.22 * s, legY, 0],
      radius: 0.17 * s,
      zone: "accent",
      part: "leg-l",
    });
    spheres.push({
      center: [0.22 * s, legY, 0],
      radius: 0.17 * s,
      zone: "accent",
      part: "leg-r",
    });
    spheres.push({
      center: [-0.22 * s, legY + p.legLength * 0.5 * s, 0],
      radius: 0.13 * s,
      zone: "accent",
      part: "leg-l",
    });
    spheres.push({
      center: [0.22 * s, legY + p.legLength * 0.5 * s, 0],
      radius: 0.13 * s,
      zone: "accent",
      part: "leg-r",
    });
  }

  return spheres;
}

const BODY_BUILDERS = [buildBlob, buildTall, buildWide, buildSpiky];

// --- Wearable sphere builders ---

/** Bounding sphere for all head parts (supports multi-sphere heads like tall). */
function getHeadBounds(
  spheres: Sphere[],
): { center: V3; radius: number } | null {
  const heads = spheres.filter((s) => s.part === "head");
  if (heads.length === 0) return null;
  if (heads.length === 1) {
    return { center: heads[0].center, radius: heads[0].radius };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let hz = 0;
  for (const h of heads) {
    minX = Math.min(minX, h.center[0] - h.radius);
    maxX = Math.max(maxX, h.center[0] + h.radius);
    minY = Math.min(minY, h.center[1] - h.radius);
    maxY = Math.max(maxY, h.center[1] + h.radius);
    hz = h.center[2];
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const radius = Math.max((maxX - minX) / 2, (maxY - minY) / 2);
  return { center: [cx, cy, hz], radius };
}

function buildHeadphoneSpheres(spheres: Sphere[]): Sphere[] {
  const head = getHeadBounds(spheres);
  if (!head) return [];

  const [hx, hy, hz] = head.center;
  const hr = head.radius;
  const result: Sphere[] = [];

  // Ear cups — two spheres at ±headRadius, vertically centered on head
  const cupR = hr * 0.28;
  result.push({
    center: [hx - hr * 0.95, hy, hz],
    radius: cupR,
    zone: "wearable",
    part: "head",
  });
  result.push({
    center: [hx + hr * 0.95, hy, hz],
    radius: cupR,
    zone: "wearable",
    part: "head",
  });

  // Band — arc of spheres over the top of the head
  const bandR = hr * 0.18;
  const bandSteps = 9;
  for (let i = 0; i <= bandSteps; i++) {
    const t = i / bandSteps; // 0 = left cup, 1 = right cup
    const angle = Math.PI * t; // π to 0 — arc over the top
    const bx = hx + Math.cos(angle) * hr * 0.95;
    const by = hy - Math.sin(angle) * hr * 1.05;
    result.push({
      center: [bx, by, hz],
      radius: bandR,
      zone: "wearable",
      part: "head",
    });
  }

  return result;
}

function buildRainbowHeadbandSpheres(spheres: Sphere[]): Sphere[] {
  const head = getHeadBounds(spheres);
  if (!head) return [];

  const [hx, hy, hz] = head.center;
  const hr = head.radius;
  const result: Sphere[] = [];
  const bandR = hr * 0.19;
  const bandSteps = 20;
  // Sweatband: full ring; front (-Z) lifted above eyes, sides/back stay lower.
  const baseBandY = hy - hr * 0.38;
  const bandRadius = hr * 0.92;

  const eyes = spheres.filter((s) => s.part === "eye");
  let frontLift = hr * 0.22;
  if (eyes.length > 0) {
    const eyeTopY = Math.min(...eyes.map((e) => e.center[1] - e.radius));
    const targetFrontY = eyeTopY - bandR * 1.15;
    frontLift = Math.max(hr * 0.1, baseBandY - targetFrontY);
  }

  for (let i = 0; i <= bandSteps; i++) {
    const angle = (i / bandSteps) * Math.PI * 2;
    // sin(angle) = -1 at front face (toward camera)
    const frontWeight = Math.max(0, -Math.sin(angle)) ** 0.85;
    const by = baseBandY - frontWeight * frontLift;
    result.push({
      center: [
        hx + Math.cos(angle) * bandRadius,
        by,
        hz + Math.sin(angle) * bandRadius,
      ],
      radius: bandR,
      zone: "wearable",
      part: "head",
      color: RAINBOW_HEADBAND[i % RAINBOW_HEADBAND.length],
    });
  }

  return result;
}

function appendWearableSpheres(spheres: Sphere[], wearables?: string[]): void {
  if (!wearables?.length) return;
  if (wearables.includes("headphones"))
    spheres.push(...buildHeadphoneSpheres(spheres));
  if (wearables.includes("rainbow-headband"))
    spheres.push(...buildRainbowHeadbandSpheres(spheres));
}

function buildCreatureSpheres(params: CreatureParams, stage: number): Sphere[] {
  const spheres = BODY_BUILDERS[params.bodyType](params, stage);
  centerVertically(spheres);
  return spheres;
}

// --- Idle animation offsets ---
// Returns a copy of the sphere list with per-part Y offsets applied.

function applyIdleOffsets(spheres: Sphere[], frameIdx: number): Sphere[] {
  function offset(
    part: { amp: number; period: number },
    phase: number,
  ): number {
    const cycles = Math.round(IDLE_TOTAL_MS / part.period);
    return (
      Math.sin(2 * Math.PI * (frameIdx / IDLE_FRAMES) * cycles + phase) *
      part.amp
    );
  }

  const bodyOff = offset(IDLE.body, 0);
  const headOff = offset(IDLE.head, 0);
  const eyeOff = headOff; // eyes follow head exactly
  const earOff = offset(IDLE.ear, Math.PI / 4);
  const spikeOff = offset(IDLE.spike, Math.PI / 3);
  const limbLOff = offset(IDLE.limb, 0);
  const limbROff = offset(IDLE.limb, Math.PI); // mirrored phase

  return spheres.map((s) => {
    let dy = 0;
    if (s.part === "body") dy = bodyOff;
    else if (s.part === "head") dy = headOff;
    else if (s.part === "eye" || s.part === "pupil") dy = eyeOff;
    else if (s.part === "ear") dy = earOff;
    else if (s.part === "spike") dy = spikeOff;
    else if (s.part === "arm-l" || s.part === "leg-l") dy = limbLOff;
    else if (s.part === "arm-r" || s.part === "leg-r") dy = limbROff;

    return {
      ...s,
      center: [s.center[0], s.center[1] + dy, s.center[2]] as V3,
    };
  });
}

// --- Anchor points ---

function getAnchors(
  spheres: Sphere[],
  _params: CreatureParams,
  stage: number,
): AnchorPoint[] {
  const headBounds = getHeadBounds(spheres);
  if (!headBounds) return [];

  const anchors: AnchorPoint[] = [
    {
      name: "hat",
      localOffset: [0, -headBounds.radius * 1.1, 0],
      parentPart: "head",
      normalDir: [0, -1, 0],
    },
  ];

  if (stage >= 2) {
    const leftArm = spheres.find((s) => s.part === "arm-l");
    const rightArm = spheres.find((s) => s.part === "arm-r");
    if (leftArm) {
      anchors.push({
        name: "leftHand",
        localOffset: [-leftArm.radius, 0, 0],
        parentPart: "arm-l",
        normalDir: [-1, 0, 0],
      });
    }
    if (rightArm) {
      anchors.push({
        name: "rightHand",
        localOffset: [rightArm.radius, 0, 0],
        parentPart: "arm-r",
        normalDir: [1, 0, 0],
      });
    }
  }

  if (stage >= 3) {
    const bodySphere = spheres.find((s) => s.part === "body");
    if (bodySphere) {
      anchors.push({
        name: "neck",
        localOffset: [0, -bodySphere.radius * 0.9, -bodySphere.radius * 0.3],
        parentPart: "body",
        normalDir: [0, 0, -1],
      });
      anchors.push({
        name: "back",
        localOffset: [0, 0, bodySphere.radius * 1.1],
        parentPart: "body",
        normalDir: [0, 0, 1],
      });
    }
  }

  return anchors;
}

// --- Ray-sphere intersection ---

function raySphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  r: number,
): number {
  const lx = ox - cx,
    ly = oy - cy,
    lz = oz - cz;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (lx * dx + ly * dy + lz * dz);
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t > 0 ? t : -1;
}

// --- Texture patterns ---

function applyTexture(
  textureType: number,
  nx: number,
  ny: number,
  nz: number,
): number {
  const theta = Math.atan2(nx, nz);
  const phi = Math.asin(Math.max(-1, Math.min(1, ny)));

  switch (textureType) {
    case 1: // Spots
      return Math.sin(theta * 7) * Math.sin(phi * 7) > 0.3 ? 0.12 : 0;
    case 2: // Stripes
      return Math.sin(phi * 10) > 0.2 ? 0.1 : 0;
    case 3: // Gradient (darker at bottom)
      return (ny * 0.5 + 0.5) * 0.12 - 0.06;
    default: // Plain
      return 0;
  }
}

// --- Anchor projection (FOV-based) ---

function projectPoint(
  p: V3,
  cols: number,
  halfW: number,
): [number, number, number] {
  const relZ = p[2] + CAM;
  if (relZ <= 0.01) return [cols / 2, SH / 2, 0];
  const ndcX = p[0] / (relZ * halfW);
  const ndcY = p[1] / (relZ * HALF_H);
  return [(ndcX + 1) * 0.5 * cols, (ndcY + 1) * 0.5 * SH, relZ];
}

// --- Color for zone ---

function zoneColor(
  zone: ColorZone,
  brightness: number,
  colors: ColorTriplet,
): string {
  switch (zone) {
    case "eye":
      return EYE_COLOR;
    case "pupil":
      return "#111111";
    case "accent":
      return brightness > 0.45 ? colors.base : colors.dim;
    case "dark":
      return colors.dim;
    case "wearable":
      return brightness > 0.6 ? "#888" : brightness > 0.3 ? "#666" : "#444";
    default:
      return brightness > 0.6
        ? colors.bright
        : brightness > 0.3
          ? colors.base
          : colors.dim;
  }
}

// --- Frame renderer ---

function renderCreatureFrame(
  spheres: Sphere[],
  yAngle: number,
  textureType: number,
  anchorDefs: AnchorPoint[],
  colors: ColorTriplet,
  cols: number = SW,
): FrameData {
  const halfW = cols === SW ? HALF_W : halfWidthFor(cols);
  const transformed = spheres.map((s) => {
    const tilted: V3 = [
      s.center[0],
      s.center[1] * TILT_COS - s.center[2] * TILT_SIN,
      s.center[1] * TILT_SIN + s.center[2] * TILT_COS,
    ];
    return {
      center: rotY(tilted, yAngle),
      radius: s.radius,
      zone: s.zone,
      part: s.part,
      color: s.color,
    };
  });

  const bright: number[][] = Array.from({ length: SH }, () =>
    Array(cols).fill(-1),
  );
  const zones: ColorZone[][] = Array.from({ length: SH }, () =>
    Array<ColorZone>(cols).fill("primary"),
  );
  const pixelColors: (string | null)[][] = Array.from({ length: SH }, () =>
    Array(cols).fill(null),
  );

  const oz = -CAM;

  for (let sy = 0; sy < SH; sy++) {
    for (let sx = 0; sx < cols; sx++) {
      const ndcX = ((sx + 0.5) / cols) * 2 - 1;
      const ndcY = ((sy + 0.5) / SH) * 2 - 1;
      const px = ndcX * halfW;
      const py = ndcY * HALF_H;
      const dLen = Math.sqrt(px * px + py * py + 1);
      const dx = px / dLen;
      const dy = py / dLen;
      const dz = 1 / dLen;

      let nearestT = Number.POSITIVE_INFINITY;
      let nearestIdx = -1;

      for (let i = 0; i < transformed.length; i++) {
        const sp = transformed[i];
        const t = raySphere(
          0,
          0,
          oz,
          dx,
          dy,
          dz,
          sp.center[0],
          sp.center[1],
          sp.center[2],
          sp.radius,
        );
        if (t > 0 && t < nearestT) {
          nearestT = t;
          nearestIdx = i;
        }
      }

      if (nearestIdx < 0) continue;

      const sp = transformed[nearestIdx];
      const hx = dx * nearestT;
      const hy = dy * nearestT;
      const hz = oz + dz * nearestT;

      const nx = (hx - sp.center[0]) / sp.radius;
      const ny = (hy - sp.center[1]) / sp.radius;
      const nz = (hz - sp.center[2]) / sp.radius;

      const normal: V3 = [nx, ny, nz];
      // Directional diffuse — max(0, ...) produces proper lit/shadow gradient
      const diffuse = Math.max(0, dot3(normal, LIGHT));

      let lit: number;
      if (sp.zone === "pupil") {
        // Force pupils to bottom 2 RAMP characters regardless of lighting
        lit = 1 / (RAMP_HERZIE.length - 1);
      } else if (sp.zone === "eye") {
        lit = 0.75 * (0.15 + 0.85 * diffuse);
      } else {
        const baseBright = 0.5 + applyTexture(textureType, nx, ny, nz);
        lit = baseBright * (0.15 + 0.85 * diffuse);
      }
      bright[sy][sx] = lit;
      zones[sy][sx] = sp.zone;
      if (sp.color) pixelColors[sy][sx] = sp.color;
    }
  }

  const EMPTY_CELL: Cell = { ch: " ", color: "" };
  const cells: Cell[][] = bright.map((row, y) =>
    row.map((val, x) => {
      if (val < 0) return EMPTY_CELL;
      const idx = Math.min(
        Math.floor(val * (RAMP_HERZIE.length - 1)),
        RAMP_HERZIE.length - 1,
      );
      const ch = RAMP_HERZIE[idx];
      if (ch === " ") return EMPTY_CELL;
      const fixed = pixelColors[y][x];
      const color = fixed
        ? shadeWearableColor(fixed, val)
        : zoneColor(zones[y][x], val, colors);
      return { ch, color };
    }),
  );

  // Compute anchor screen positions
  const anchors: Record<string, FrameAnchor> = {};
  for (const anchor of anchorDefs) {
    const parentIdx = spheres.findIndex((s) => s.part === anchor.parentPart);
    if (parentIdx < 0) continue;

    const worldPos: V3 = [
      spheres[parentIdx].center[0] + anchor.localOffset[0],
      spheres[parentIdx].center[1] + anchor.localOffset[1],
      spheres[parentIdx].center[2] + anchor.localOffset[2],
    ];
    const tilted: V3 = [
      worldPos[0],
      worldPos[1] * TILT_COS - worldPos[2] * TILT_SIN,
      worldPos[1] * TILT_SIN + worldPos[2] * TILT_COS,
    ];
    const rotated = rotY(tilted, yAngle);
    const [screenX, screenY, depth] = projectPoint(rotated, cols, halfW);

    const nTilted: V3 = [
      anchor.normalDir[0],
      anchor.normalDir[1] * TILT_COS - anchor.normalDir[2] * TILT_SIN,
      anchor.normalDir[1] * TILT_SIN + anchor.normalDir[2] * TILT_COS,
    ];
    const nRotated = rotY(nTilted, yAngle);
    const visible = nRotated[2] < 0;

    const parentRadius = transformed[parentIdx].radius;
    const screenRadius =
      depth > 0.01 ? (parentRadius / depth) * ((cols * 0.5) / halfW) : 0;

    anchors[anchor.name] = {
      screenX: Math.round(screenX),
      screenY: Math.round(screenY),
      visible,
      depth,
      screenRadius,
    };
  }

  return { cells, anchors };
}

// --- Public API ---

const frameCache = new Map<string, FrameData[]>();

/**
 * Generate idle animation frames — fixed Y angle with per-part breathing offsets.
 * 60 frames at 50ms = 3s loop.
 */
export function generateIdleFrames(
  userId: string,
  stage: number,
  wearables?: string[],
  paramsOverride?: CreatureParams,
  cols: number = SW,
): FrameData[] {
  const key = `idle:${paramsCacheKey(userId, paramsOverride)}:${stage}:${wearables?.sort().join(",") ?? ""}:${cols}`;
  const cached = frameCache.get(key);
  if (cached) return cached;

  const params = resolveCreatureParams(userId, paramsOverride);
  const baseSpheres = buildCreatureSpheres(params, stage);
  appendWearableSpheres(baseSpheres, wearables);
  const anchors = getAnchors(baseSpheres, params, stage);
  const colors = buildColorTriplet(CREATURE_PALETTE[params.colorIndex]);

  const frames = Array.from({ length: IDLE_FRAMES }, (_, i) => {
    const animated = applyIdleOffsets(baseSpheres, i);
    return renderCreatureFrame(
      animated,
      DEFAULT_Y_ANGLE,
      params.textureType,
      anchors,
      colors,
      cols,
    );
  });

  frameCache.set(key, frames);
  return frames;
}

/**
 * Generate rotation animation frames — continuous Y-axis spin.
 * 36 frames at 80ms.
 */
export function generateRotationFrames(
  userId: string,
  stage: number,
  frameCount = 36,
  wearables?: string[],
  paramsOverride?: CreatureParams,
  cols: number = SW,
): FrameData[] {
  const key = `rot:${paramsCacheKey(userId, paramsOverride)}:${stage}:${wearables?.sort().join(",") ?? ""}:${cols}`;
  const cached = frameCache.get(key);
  if (cached) return cached;

  const params = resolveCreatureParams(userId, paramsOverride);
  const spheres = buildCreatureSpheres(params, stage);
  appendWearableSpheres(spheres, wearables);
  const anchors = getAnchors(spheres, params, stage);
  const colors = buildColorTriplet(CREATURE_PALETTE[params.colorIndex]);

  const frames = Array.from({ length: frameCount }, (_, i) =>
    renderCreatureFrame(
      spheres,
      (i / frameCount) * Math.PI * 2,
      params.textureType,
      anchors,
      colors,
      cols,
    ),
  );

  frameCache.set(key, frames);
  return frames;
}

/**
 * Generate dance animation frames — rhythmic bounce at DEFAULT_Y_ANGLE.
 * 24 frames at 35ms = 840ms loop.
 */
export function generateDanceFrames(
  userId: string,
  stage: number,
  wearables?: string[],
  paramsOverride?: CreatureParams,
  cols: number = SW,
): FrameData[] {
  const key = `dance:${paramsCacheKey(userId, paramsOverride)}:${stage}:${wearables?.sort().join(",") ?? ""}:${cols}`;
  const cached = frameCache.get(key);
  if (cached) return cached;

  const params = resolveCreatureParams(userId, paramsOverride);
  const baseSpheres = buildCreatureSpheres(params, stage);
  appendWearableSpheres(baseSpheres, wearables);
  const anchors = getAnchors(baseSpheres, params, stage);
  const colors = buildColorTriplet(CREATURE_PALETTE[params.colorIndex]);

  const frames = Array.from({ length: DANCE_FRAMES }, (_, i) => {
    const animated = applyDanceOffsets(baseSpheres, i);
    return renderCreatureFrame(
      animated,
      DEFAULT_Y_ANGLE,
      params.textureType,
      anchors,
      colors,
      cols,
    );
  });

  frameCache.set(key, frames);
  return frames;
}

/**
 * Render a single frame at an arbitrary Y angle with idle or dance offsets.
 * Used for real-time drag rendering. Produces identical output to
 * pre-computed frames when called with DEFAULT_Y_ANGLE.
 */
export function renderCreatureAtAngle(
  userId: string,
  stage: number,
  yAngle: number,
  frameIdx: number,
  dancing = false,
  wearables?: string[],
  paramsOverride?: CreatureParams,
  cols: number = SW,
): FrameData {
  const params = resolveCreatureParams(userId, paramsOverride);
  const baseSpheres = buildCreatureSpheres(params, stage);
  appendWearableSpheres(baseSpheres, wearables);
  const anchors = getAnchors(baseSpheres, params, stage);
  const colors = buildColorTriplet(CREATURE_PALETTE[params.colorIndex]);
  const animated = dancing
    ? applyDanceOffsets(baseSpheres, frameIdx)
    : applyIdleOffsets(baseSpheres, frameIdx);
  return renderCreatureFrame(
    animated,
    yAngle,
    params.textureType,
    anchors,
    colors,
    cols,
  );
}

export function getCreatureColors(
  userId: string,
  paramsOverride?: CreatureParams,
): {
  dim: string;
  base: string;
  bright: string;
} {
  const params = resolveCreatureParams(userId, paramsOverride);
  return buildColorTriplet(CREATURE_PALETTE[params.colorIndex]);
}

export function clearCreatureCache(): void {
  frameCache.clear();
}
