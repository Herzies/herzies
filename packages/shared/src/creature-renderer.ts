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
  GOLD_RAMP,
  LIGHT,
  NANDOR_RAMP,
  OCEAN_RAMP,
  PUMPKIN_RAMP,
  RAINBOW_RAMP,
  RAMP_HERZIE,
  rotY,
  TEAL_RAMP,
  type V3,
  VIOLET_RAMP,
  VOID_RAMP,
} from "./ascii3d.js";
import {
  type DangleState,
  DEFAULT_DANGLE_CONFIG,
  steadyDangle,
} from "./dangle-physics.js";
import {
  EQUIPPED_SLOTS,
  type Equipped,
  type GroundSide,
  groundSlot,
} from "./items.js";

// --- Creature viewport ---
const SW = 80;
const SH = 48;
/**
 * Camera distance from the herzie's centre. Closer means stronger perspective:
 * whatever swings toward the camera (a limb, the eyes) is drawn bigger. The
 * field of view follows it so the frame at the centre stays the same size —
 * moving the camera changes depth exaggeration, not framing.
 */
// Tuned by eye in the sandbox: 2.0 (the original) swelled limbs badly as they
// swung toward the camera.
export const DEFAULT_CAMERA_DISTANCE = 2.7;
/** View-plane half-height at the herzie's centre (z = 0), in world units.
 * Fixed: it is the framing — the original camera's (distance 2.0, vertical
 * field of view 1.8 rad), whatever the distance now. */
const FRAME_HALF_H = 2.0 * Math.tan(1.8 / 2);

let CAM = DEFAULT_CAMERA_DISTANCE;
let HALF_H = FRAME_HALF_H / CAM;

/** Tooling (the sandbox): move the camera, keeping the framing. Callers must
 * clearCreatureCache() afterwards — cached frames were rendered at the old
 * distance. */
export function setCameraDistance(distance: number): void {
  CAM = distance;
  HALF_H = FRAME_HALF_H / CAM;
}

/** Horizontal half-extent of the view plane for a given column count. */
function halfWidthFor(cols: number, rows: number = SH): number {
  return HALF_H * ((cols / rows) * (1 / CHAR_ASPECT));
}
/** How far the herzie leans back toward the camera, in degrees: positive
 * shows more of the top of its head. Tuned in the sandbox (was 8). */
export const DEFAULT_CAMERA_TILT_DEG = 3;
let TILT_COS = Math.cos((DEFAULT_CAMERA_TILT_DEG * Math.PI) / 180);
let TILT_SIN = Math.sin((DEFAULT_CAMERA_TILT_DEG * Math.PI) / 180);

/** Tooling (the sandbox): change the tilt. Like setCameraDistance, callers
 * must clearCreatureCache() afterwards. */
export function setCameraTilt(degrees: number): void {
  TILT_COS = Math.cos((degrees * Math.PI) / 180);
  TILT_SIN = Math.sin((degrees * Math.PI) / 180);
}

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

/**
 * Boss eyes. A separate zone rather than a different EYE_COLOR: that constant
 * is shared by every creature in the game and is asserted directly in
 * creature-renderer.test.ts, so recolouring it would repaint every herzie.
 */
const EVIL_EYE_BRIGHT = "#FF6A45";
const EVIL_EYE_BASE = "#E5200B";
const EVIL_EYE_DIM = "#7A0C04";

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

const RAINBOW_HEADBAND = RAINBOW_RAMP;

function shadeWearableColor(hex: string, brightness: number): string {
  const [h, s, l] = hexToHsl(hex);
  // Never darken highlights — a 0.88 cap turned pure white into gray.
  if (brightness > 0.6) return hslToHex(h, s, Math.min(1, l + (1 - l) * 0.4));
  if (brightness > 0.3) return hex.toUpperCase();
  // Keep near-white ceramics readable (avoid muddy mid-gray shadows).
  const shadowL = l > 0.85 ? l * 0.78 : l * 0.55;
  return hslToHex(h, s, shadowL);
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
// `cycles` is full sine cycles per loop, so every part tiles seamlessly.
const IDLE_FRAMES = 120; // at 50ms per frame (Herzie3D) — a 6000ms loop

const IDLE = {
  body: { amp: 0.04, cycles: 4 }, // 1500ms
  head: { amp: 0.025, cycles: 2 }, // 3000ms
  eye: { amp: 0.025, cycles: 2 }, // follows head
  limb: { amp: 0.03, cycles: 4 }, // 1500ms
  ear: { amp: 0.02, cycles: 2 }, // 3000ms
  spike: { amp: 0.015, cycles: 2 }, // follows ears
  // Spirit Orb — one slow breath across the whole loop, deliberately calmer
  // than any herzie part. It is the reason the loop is 6s rather than 3s.
  spirit: { amp: 0.04, cycles: 1 }, // 6000ms
} as const;

// --- Dance animation constants ---
// Energetic rhythmic motion — ~2.5-3× idle amplitudes, faster cycle.
const DANCE_FRAMES = 24;
// 65ms per frame → 1560ms loop (~77 BPM); interval applied by the animator.

const DANCE = {
  body: { amp: 0.11, cycles: 2 },
  head: { amp: 0.07, cycles: 2 }, // phase π/3 — nods slightly behind body
  eye: { amp: 0.07, cycles: 2 }, // follows head
  limb: { amp: 0.09, cycles: 2 }, // L at 0, R at π — alternating sway
  ear: { amp: 0.055, cycles: 4 }, // double body freq — floppy
  spike: { amp: 0.04, cycles: 4, xAmp: 0.03, xCycles: 2 }, // Y bounce + lateral X sway
  ground: { amp: 0.06, cycles: 2 }, // boombox hop — upward bounce on the beat
  spirit: { amp: 0.08, cycles: 1 }, // Spirit Orb — slow smooth float, not a hop
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

type ColorZone =
  | "primary"
  | "accent"
  | "eye"
  | "pupil"
  | "dark"
  | "wearable"
  | "eye-evil";

export interface Sphere {
  center: V3;
  radius: number;
  zone: ColorZone;
  part: string;
  /** Fixed color for wearables (shaded by lighting at render time). */
  color?: string;
  /** Set on spheres that hang loose (necklace links) and so react to a spin —
   * see applyDangle and dangle-physics.ts. */
  dangle?: Dangle;
}

interface Dangle {
  /** How much of the chain's swing this sphere takes: ~0 at the back of the
   * neck where it's held, 1 at the pendant. */
  weight: number;
  /** How far it hangs below where it's held — what a flare lifts back up. */
  hang: number;
  /** The vertical axis it swings around (the neck's), as [x, z]. */
  pivot: [number, number];
}

// --- Dance animation offsets ---
// Returns a copy of the sphere list with per-part dance offsets applied.
// Adds X-axis sway for spikes in addition to Y-axis bounce.

function applyDanceOffsets(
  spheres: Sphere[],
  frameIdx: number,
  hops: readonly SpiritHop[] = [],
): Sphere[] {
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
  // Boombox hops upward on the beat (negative Y is up).
  const groundOff =
    -Math.abs(Math.sin(2 * Math.PI * t * DANCE.ground.cycles)) *
    DANCE.ground.amp;
  // Greedy Spirit floats with a slow smooth bob — half the body's cycle count,
  // so it visibly lags the beat — plus any on-beat hops of this loop variant.
  const moveSpirit = spiritMover(
    spheres,
    frameIdx,
    hops,
    yOff(DANCE.spirit.amp, DANCE.spirit.cycles, Math.PI / 5),
  );
  // Other floating pets keep the spirit's slow bob but never hop: the hop
  // poses are the Greedy Spirit's, keyed on its single core sphere.
  const petOff = yOff(DANCE.spirit.amp, DANCE.spirit.cycles, Math.PI / 5);

  return spheres.map((s) => {
    if (s.part === "spirit") return moveSpirit(s);
    if (s.part === "pet") {
      return {
        ...s,
        center: [s.center[0], s.center[1] + petOff, s.center[2]] as V3,
      };
    }
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
    else if (s.part === "ground") dy = groundOff;

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

/** Only "spiky" and "boss" look different from the others: blob, tall and wide
 * all build the same herzie body now (see HERZIE_BODY), and the names are kept
 * because the seeded roll that picks between them is not allowed to move. */
export const CREATURE_BODY_TYPES = [
  "blob",
  "tall",
  "wide",
  "spiky",
  "boss",
] as const;

export const CREATURE_PARAM_BOUNDS = {
  // max is 4 ("boss") so the sandbox slider can reach it, but the seeded
  // generator deliberately stops at 3 — see generateCreatureParams.
  bodyType: { min: 0, max: 4, step: 1 },
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

function boomboxKey(config?: BoomboxConfig): string {
  return config ? JSON.stringify(config) : "";
}

export function generateCreatureParams(userId: string): CreatureParams {
  const seed = simpleHash(userId);
  const rng = mulberry32(seed);

  return {
    // Hardcoded 3, NOT CREATURE_PARAM_BOUNDS.bodyType.max — "boss" is index 4
    // and must stay unreachable here. Widening this would consume the same
    // rng() call but remap bodyType for every existing seed, silently
    // changing what every herzie in the wild looks like. Bosses arrive only
    // via the creatureParams override prop.
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

// --- The herzie body ---

/**
 * Every herzie has these proportions. They are Mathias's stage-3 herzie
 * (seed HERZ-MSL5, the wide body type), which is the shape everyone settled
 * on; before this, four builders each sized head, body and limbs differently
 * from the seeded params, and one of them (tall) read as three blobs — head,
 * neck, body.
 *
 * What still varies from herzie to herzie is the eyes (spacing, size,
 * height), the ears, and the spikes on a spiky one. Colour and texture vary
 * too, but they are not dimensions.
 *
 * These are constants here, NOT changes to generateCreatureParams. That
 * function rolls all thirteen params in a fixed order, so dropping or
 * reordering any of the size ones would hand every later param — the eyes and
 * ears we are keeping — a different value for every existing seed. The seeded
 * size params are still rolled and simply not read by the herzie builder. The
 * boss still reads them, which is the other reason to leave the generator
 * alone.
 */
const HERZIE_BODY = {
  // Verbatim from generateCreatureParams("HERZ-MSL5"), not rounded: rounding
  // to three places moved 20 cells across a 12-angle turn.
  scale: 0.9873104626312852,
  headRatio: 0.7309588266070932,
  legLength: 0.3828585948329419,
} as const;

/** The body type whose herzies carry spikes instead of ears. 0-2 all build
 * the same body now; the roll is unchanged (see generateCreatureParams). */
const SPIKY_BODY_TYPE = 3;

function buildHerzie(p: CreatureParams, stage: number): Sphere[] {
  const s = HERZIE_BODY.scale * CS;
  const spheres: Sphere[] = [];

  // The head grows: smallest at stage 1, a little bigger at stage 2, and the
  // template's own size from stage 3 on. Ears, spikes and arms are placed from
  // headR, so they follow it; the eyes keep their absolute size, which makes
  // the young ones look big-eyed.
  const headGrowth = stage === 1 ? 0.7 : stage === 2 ? 0.85 : 1;
  const headR = 0.78 * HERZIE_BODY.headRatio * s * headGrowth;
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

  const spiky = p.bodyType === SPIKY_BODY_TYPE;

  if (spiky) {
    // A crest over the top of the head, standing in for ears. The count and
    // size come from the ear params, as they always have for spiky.
    const spikeCount = 2 + p.earCount;
    const spikeR = p.earLength * 0.4 * s;
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
  } else {
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
    if (spiky) {
      for (const side of [-1, 1]) {
        spheres.push({
          center: [side * (armX + 0.14 * s), armY, 0],
          radius: 0.07 * s,
          zone: "accent",
          part: "spike",
        });
      }
    }
  }

  if (stage >= 3) {
    const bodyR = 0.5 * s;
    const bodyY = 0.18 * s;
    spheres.push({
      center: [0, bodyY, 0],
      radius: bodyR,
      zone: "primary",
      part: "body",
    });
    if (spiky) {
      for (const side of [-1, 1]) {
        spheres.push({
          center: [side * (bodyR + 0.05 * s), bodyY, 0],
          radius: 0.09 * s,
          zone: "accent",
          part: "spike",
        });
      }
    }

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
      center: [-legX, legY + HERZIE_BODY.legLength * 0.4 * s, 0],
      radius: 0.15 * s,
      zone: "accent",
      part: "leg-l",
    });
    spheres.push({
      center: [legX, legY + HERZIE_BODY.legLength * 0.4 * s, 0],
      radius: 0.15 * s,
      zone: "accent",
      part: "leg-r",
    });
  }

  return spheres;
}

/**
 * Boss — a corrupted herzie, for the Boss Fight event.
 *
 * Deliberately breaks the rules the herzie builder follows, because those
 * rules are what make a herzie read as friendly:
 *
 *  - The head is SMALLER than the body and sunk into it, so the thing hunches
 *    instead of standing up. The herzie builder gives the head top billing.
 *  - The spike crown is a full ring, not a spiky herzie's front-facing half-arc,
 *    so the silhouette stays hostile from behind while it rotates.
 *  - It is asymmetric. Herzies are mirror-symmetric; a lopsided shoulder and
 *    an off-centre crown are most of what makes this look wrong.
 *  - No legs. The body bottoms out and VOID_RAMP takes it to near-black, so
 *    it looks like it continues past where you can see.
 *
 * `stage` is ignored — a boss is never half-grown.
 */
function buildBoss(p: CreatureParams, _stage: number): Sphere[] {
  const s = p.bodyScale * CS * 0.86;
  const spheres: Sphere[] = [];

  // --- Bulk ---
  // Two stacked spheres rather than one big one: a single sphere wide enough
  // to look heavy also looks like a mound, and the creature stops reading as
  // something that stands up.
  const bodyY = 0.3 * s;
  const bodyR = 0.42 * s;
  spheres.push({
    center: [0, bodyY, 0],
    radius: bodyR,
    zone: "primary",
    part: "body",
  });
  spheres.push({
    center: [0.02 * s, bodyY + 0.34 * s, 0],
    radius: 0.36 * s,
    zone: "primary",
    part: "body",
  });

  // Lopsided shoulders: the right one rides higher and larger. This single
  // asymmetry does more for "wrong" than any amount of extra geometry.
  spheres.push({
    center: [-0.38 * s, bodyY - 0.16 * s, 0.04 * s],
    radius: 0.21 * s,
    zone: "primary",
    part: "body",
  });
  spheres.push({
    center: [0.43 * s, bodyY - 0.26 * s, -0.02 * s],
    radius: 0.26 * s,
    zone: "primary",
    part: "body",
  });

  // --- Head, sunk low and forward ---
  // Unlike every other builder, this head is NOT at the origin — it is nudged
  // right and toward the camera. Anything seated against its surface has to
  // add headX/headZ back in; eyeZ() assumes an origin-centred head.
  const headR = 0.44 * p.headRatio * s * 1.25;
  const headY = bodyY - bodyR * 1.35;
  const headX = 0.03 * s;
  const headZ = -0.08 * s;
  spheres.push({
    center: [headX, headY, headZ],
    radius: headR,
    zone: "primary",
    part: "head",
  });

  // Brow ridge — a dark bar across the top of the eyes. The scowl comes from
  // this, not from the eyes themselves.
  spheres.push({
    center: [headX - 0.1 * s, headY - headR * 0.44, headZ - headR * 0.72],
    radius: headR * 0.34,
    zone: "dark",
    part: "head",
  });
  spheres.push({
    center: [headX + 0.1 * s, headY - headR * 0.5, headZ - headR * 0.68],
    radius: headR * 0.3,
    zone: "dark",
    part: "head",
  });

  // --- Eyes: small, close-set, under the brow ---
  const ex = Math.max(0.055, p.eyeSpacing * 0.62) * s;
  const er = Math.max(0.04, p.eyeSize * 0.52) * s;
  const ey = headY - headR * 0.06;
  const ez = headZ + eyeZ(headR, ex, ey - headY, er);
  for (const dir of [-1, 1]) {
    spheres.push({
      center: [headX + dir * ex, ey, ez],
      radius: er,
      zone: "eye-evil",
      part: "eye",
    });
  }

  // --- Crown: a full ring of spikes, longest at the back ---
  const crownCount = 7 + p.earCount * 2;
  for (let i = 0; i < crownCount; i++) {
    const a = (i / crownCount) * Math.PI * 2 + 0.4;
    // Longest toward the back of the ring, so the profile reads as a mane
    // rather than a uniform sea urchin.
    const lean = 0.55 + 0.45 * Math.cos(a);
    const len = headR * (0.42 + p.earLength * 1.6) * lean;
    const ringR = headR * 0.86;
    spheres.push({
      center: [
        headX + Math.cos(a) * ringR,
        headY - headR * 0.5 - len * 0.5,
        // Z kept deliberately shallow. CAM is only 2.0 units out by default, so anything
        // with real depth swells hugely as it rotates toward the camera and
        // pushes the creature past SH=48. The ring reads as a ring from the
        // silhouette alone; it does not need the depth to sell it.
        headZ + Math.sin(a) * ringR * 0.42,
      ],
      radius: Math.max(0.03 * s, len * 0.34),
      zone: "accent",
      part: "spike",
    });
  }

  // Two horns sweeping up and out off the skull. Same shallow-Z rule as the
  // crown — these were the worst offender for clipping at side-on angles.
  for (const side of [-1, 1]) {
    for (let seg = 0; seg < 3; seg++) {
      const t = seg / 2;
      spheres.push({
        center: [
          headX + side * (0.2 + t * 0.3) * s,
          headY - headR * (0.85 + t * 0.6),
          headZ + (0.04 + t * 0.1) * s,
        ],
        radius: (0.085 - t * 0.024) * s,
        zone: "accent",
        part: "spike",
      });
    }
  }

  // --- Arms: long, hanging well past the body ---
  for (const [side, part] of [
    [-1, "arm-l"],
    [1, "arm-r"],
  ] as const) {
    // Set well outboard of the shoulders so the arms stay a separate shape in
    // silhouette instead of dissolving into the torso mass.
    const ax = side * 0.5 * s;
    const reach = p.armLength * 1.3;
    const shoulderY = bodyY - 0.14 * s;
    const wristY = bodyY + reach * s;

    // The arms curve INWARD as they fall, so the claws gather near the
    // centreline. Two reasons, and the first is the load-bearing one:
    // splayed-out long arms swing close to the camera on rotation and the
    // perspective blow-up pushed the creature off the bottom of the grid at
    // side-on angles. It also reads better — gathered claws look poised.
    const SEGMENTS = 5;
    for (let seg = 0; seg <= SEGMENTS; seg++) {
      const t = seg / SEGMENTS;
      const taper = 1 - 0.42 * t * t;
      spheres.push({
        center: [ax * taper, shoulderY + (wristY - shoulderY) * t, 0],
        radius: (0.155 - 0.05 * t) * s,
        zone: "primary",
        part,
      });
    }

    // Claw: three talons splaying off the wrist.
    const cx = ax * 0.58;
    for (let c = -1; c <= 1; c++) {
      spheres.push({
        center: [cx + c * 0.07 * s, wristY + 0.13 * s, 0.02 * s],
        radius: 0.048 * s,
        zone: "accent",
        part,
      });
      spheres.push({
        center: [cx + c * 0.095 * s, wristY + 0.23 * s, 0.03 * s],
        radius: 0.031 * s,
        zone: "accent",
        part,
      });
    }
  }

  return spheres;
}

const BODY_BUILDERS = [
  buildHerzie,
  buildHerzie,
  buildHerzie,
  buildHerzie,
  buildBoss,
];

/** Index of buildBoss in BODY_BUILDERS. Not reachable from the seeded roll. */
export const BOSS_BODY_TYPE = 4;

// --- Wearable sphere builders ---

/** Bounding sphere for all head parts (supports multi-sphere heads). Worn
 * items tagged part "head" so they move with it (fangs, a hat) are not the
 * head: counting them let fangs on the face pull a hat forward toward the
 * camera, where perspective blew it up. */
function getHeadBounds(
  spheres: Sphere[],
): { center: V3; radius: number } | null {
  const heads = spheres.filter(
    (s) => s.part === "head" && s.zone !== "wearable",
  );
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

/** Where neckwear sits: the circle where the head sphere meets the body
 * sphere. Body items need stage 3 (see ItemDef.minStage), so there is always
 * a body to sit on; without one this is null and nothing is drawn. `size` is
 * the head radius, the scale every neck item is sized from. */
interface Neck {
  center: V3;
  radius: number;
  size: number;
  body: Sphere;
}

function largestPart(spheres: Sphere[], part: string): Sphere | undefined {
  let best: Sphere | undefined;
  for (const s of spheres) {
    if (s.part === part && (!best || s.radius > best.radius)) best = s;
  }
  return best;
}

function getNeck(spheres: Sphere[]): Neck | null {
  const head = largestPart(spheres, "head");
  const body = largestPart(spheres, "body");
  if (!head || !body) return null;
  const [hx, hy, hz] = head.center;
  const hr = head.radius;
  // Circle where the two spheres intersect, measured down from the head.
  const d = body.center[1] - hy;
  const a = (d * d + hr * hr - body.radius ** 2) / (2 * d);
  return {
    center: [hx, hy + a, hz],
    radius: Math.sqrt(Math.max(0, hr * hr - a * a)),
    size: hr,
    body,
  };
}

/** Distance from the neck's vertical axis to the visible surface at height
 * `y`: the body below the seam, the seam ring itself at or above it. */
function neckSurfaceRadius(neck: Neck, y: number): number {
  if (y <= neck.center[1]) return neck.radius;
  const dy = y - neck.body.center[1];
  return Math.sqrt(Math.max(0, neck.body.radius ** 2 - dy * dy));
}

/** A loop of beads around the neck that sags toward the front (-Z), riding
 * the body's surface as it drops. Returns the front-most point so a pendant
 * can hang from it. */
function buildNecklaceBeads(
  neck: Neck,
  opts: {
    count: number;
    beadRadius: (i: number) => number;
    color: (i: number) => string;
    sag: number;
    /** Scales how far these beads swing on a spin: heavier swings further. */
    heft: number;
  },
): { beads: Sphere[]; front: V3 } {
  const [nx, ny, nz] = neck.center;
  const beads: Sphere[] = [];
  let front: V3 = [nx, ny, nz];
  for (let i = 0; i < opts.count; i++) {
    const angle = (i / opts.count) * Math.PI * 2 + Math.PI / 2;
    // sin(angle) = -1 at the front face (toward camera)
    const frontWeight = Math.max(0, -Math.sin(angle)) ** 1.6;
    const r = opts.beadRadius(i);
    const y = ny + frontWeight * opts.sag;
    const ringR = neckSurfaceRadius(neck, y) + r * 0.55;
    const center: V3 = [
      nx + Math.cos(angle) * ringR,
      y,
      nz + Math.sin(angle) * ringR,
    ];
    if (center[2] < front[2]) front = center;
    beads.push({
      center,
      radius: r,
      zone: "wearable",
      part: "body",
      color: opts.color(i),
      // The front sags and swings most; the back, held at the neck, barely.
      dangle: {
        weight: (0.2 + 0.8 * frontWeight) * opts.heft,
        hang: y - ny,
        pivot: [nx, nz],
      },
    });
  }
  return { beads, front };
}

function buildGoldChainSpheres(spheres: Sphere[]): Sphere[] {
  const neck = getNeck(spheres);
  if (!neck) return [];
  const big = neck.size * 0.11;
  const small = neck.size * 0.08;
  const { beads, front } = buildNecklaceBeads(neck, {
    count: 24,
    // Alternating link sizes and tones, so it reads as links rather than a tube.
    beadRadius: (i) => (i % 2 === 0 ? big : small),
    color: (i) => (i % 2 === 0 ? GOLD_RAMP[2] : GOLD_RAMP[3]),
    sag: neck.size * 0.3,
    heft: 1,
  });
  // Medallion hanging off the lowest link, standing proud of the chest.
  const pendR = neck.size * 0.17;
  const py = front[1] + big + pendR * 0.6;
  const pz = neck.center[2] - (neckSurfaceRadius(neck, py) + pendR * 0.55);
  beads.push({
    center: [front[0], py, pz],
    radius: pendR,
    zone: "wearable",
    part: "body",
    color: GOLD_RAMP[1],
    dangle: {
      weight: 1,
      hang: py - neck.center[1],
      pivot: [neck.center[0], neck.center[2]],
    },
  });
  return beads;
}

function buildPearlNecklaceSpheres(spheres: Sphere[]): Sphere[] {
  const neck = getNeck(spheres);
  if (!neck) return [];
  return buildNecklaceBeads(neck, {
    count: 20,
    beadRadius: () => neck.size * 0.1,
    color: (i) => (i % 2 === 0 ? "#FBF7EE" : "#EDE4D3"),
    sag: neck.size * 0.18,
    // Lighter than the chain and with no pendant: a smaller, quicker swing.
    heft: 0.7,
  }).beads;
}

function buildBowtieSpheres(spheres: Sphere[]): Sphere[] {
  const neck = getNeck(spheres);
  if (!neck) return [];
  const k = neck.size * 0.13;
  const y = neck.center[1] + k * 0.4;
  const z = neck.center[2] - (neckSurfaceRadius(neck, y) + k * 0.7);
  const wing = "#E03131";
  const knot = "#A61E1E";
  const local: [number, number, number, string][] = [[0, 0, k * 0.9, knot]];
  // Each wing is narrow at the knot and flares out to the tips.
  for (const side of [-1, 1]) {
    local.push([side * k * 1.2, 0, k * 0.8, wing]);
    local.push([side * k * 2.1, -k * 0.6, k * 0.75, wing]);
    local.push([side * k * 2.1, k * 0.6, k * 0.75, wing]);
    local.push([side * k * 2.4, 0, k * 0.7, wing]);
  }
  return local.map(([dx, dy, r, color]) => ({
    center: [neck.center[0] + dx, y + dy, z] as V3,
    radius: r,
    zone: "wearable" as const,
    part: "body",
    color,
  }));
}

/** Poses the dangling spheres for a spin's swing and flare. Flare first —
 * lifting each sphere back up by part of its hang and out from the neck —
 * then the swing, a rotation about the neck's axis. Rotating about that axis
 * keeps a link on the body's surface, since the body is round about it. */
function applyDangle(spheres: Sphere[], state: DangleState): Sphere[] {
  if (state.swing === 0 && state.flare === 0) return spheres;
  return spheres.map((s) => {
    if (!s.dangle) return s;
    const { weight, hang, pivot } = s.dangle;
    let x = s.center[0] - pivot[0];
    let z = s.center[2] - pivot[1];
    const y = s.center[1] - state.flare * hang * 0.8;
    const r = Math.hypot(x, z);
    if (r > 0) {
      const out = 1 + (state.flare * hang * 0.6) / r;
      x *= out;
      z *= out;
    }
    const [rx, , rz] = rotY([x, 0, z], state.swing * weight);
    return { ...s, center: [rx + pivot[0], y, rz + pivot[1]] as V3 };
  });
}

/** Whether anything worn swings when the herzie is spun. */
export function hasDangleEquipped(equipped?: Equipped): boolean {
  return (
    equipped?.body === "gold-chain" ||
    equipped?.body === "pearl-necklace" ||
    equipped?.head === "witch-hat"
  );
}

const BODY_ITEM_BUILDERS: Record<string, (spheres: Sphere[]) => Sphere[]> = {
  "gold-chain": buildGoldChainSpheres,
  "pearl-necklace": buildPearlNecklaceSpheres,
  bowtie: buildBowtieSpheres,
};

/** Placement/orientation overrides for the boombox ground prop. */
export interface BoomboxConfig {
  /** Yaw rotation around the vertical axis, in degrees. */
  yawDeg: number;
  /** Horizontal nudge from the auto corner placement, in world units. */
  offsetX: number;
  /** Vertical nudge (positive = down), in world units. */
  offsetY: number;
  /** Size multiplier. */
  scale: number;
}

export const DEFAULT_BOOMBOX_CONFIG: BoomboxConfig = {
  yawDeg: -33,
  offsetX: 0.18,
  // Lifted: it sits in front of the herzie, so resting on the floor itself
  // drew it a couple of rows below the feet. Tuned by eye in the app.
  offsetY: -0.42,
  scale: 1.15,
};

// Fixed world-space size basis so ground props stay the same size regardless of
// the herzie's body/stage. `scale` multiplies this. (Roughly a stage-2 herzie's
// height, which is what the placement was tuned against.)
const BOOMBOX_REF_HEIGHT = 1.26;

function groundCornerX(
  cols: number,
  side: GroundSide,
  propHalfW: number,
  bodyR: number,
  zFace: number,
  bz: number,
  offsetX: number,
): number {
  const halfW = halfWidthFor(cols);
  const relZClose = zFace + bz + CAM;
  const marginCols = 2;
  if (side === "left") {
    const leftNdc = -1 + (2 * marginCols) / cols;
    const leftWorldX = leftNdc * relZClose * halfW;
    return leftWorldX + propHalfW + bodyR + offsetX;
  }
  const rightNdc = 1 - (2 * marginCols) / cols;
  const rightWorldX = rightNdc * relZClose * halfW;
  return rightWorldX - propHalfW - bodyR - offsetX;
}

function buildBoomboxSpheres(
  spheres: Sphere[],
  cols: number,
  side: GroundSide,
  config: BoomboxConfig = DEFAULT_BOOMBOX_CONFIG,
): Sphere[] {
  if (spheres.length === 0) return [];

  // Only the creature's lowest point is needed — to rest the box at its feet.
  // Its *size* is independent of the herzie (uses BOOMBOX_REF_HEIGHT).
  let maxY = -Infinity;
  for (const s of spheres) {
    maxY = Math.max(maxY, s.center[1] + s.radius);
  }

  const bodyColor = "#aeb4ba";
  const speakerColor = "#141414";
  const coneColor = "#5a5a5a";
  const handleColor = "#2b2b2b";
  const redColor = "#e0564f";
  const playColor = "#ffd43b";

  const boomW = BOOMBOX_REF_HEIGHT * 0.32 * config.scale;
  const boomH = BOOMBOX_REF_HEIGHT * 0.16 * config.scale;
  const boomD = BOOMBOX_REF_HEIGHT * 0.11 * config.scale;
  const bodyR = boomH * 0.55;

  // --- Geometry around the box centre, facing the camera (-Z front) ---
  const zFront = -boomD * 0.5;
  const zBack = boomD * 0.5;
  const zFace = zFront - bodyR * 0.95;

  interface LocalSphere {
    c: V3;
    r: number;
    color: string;
  }
  const local: LocalSphere[] = [];
  const add = (c: V3, r: number, color: string) => local.push({ c, r, color });

  // Body: overlapping grid of spheres forming a rounded box (front + back).
  const nx = 6;
  const ny = 3;
  for (const z of [zFront, zBack]) {
    for (let ix = 0; ix < nx; ix++) {
      const fx = (ix / (nx - 1) - 0.5) * boomW;
      for (let iy = 0; iy < ny; iy++) {
        const fy = (iy / (ny - 1) - 0.5) * boomH;
        add([fx, fy, z], bodyR, bodyColor);
      }
    }
  }

  // Twin speakers protruding clearly in front of the body, each with a cone.
  for (const sideSign of [-1, 1]) {
    const scx = sideSign * boomW * 0.3;
    add([scx, 0, zFace], boomH * 0.44, speakerColor);
    add([scx, 0, zFace - boomH * 0.16], boomH * 0.2, coneColor);
  }

  // Control panel between the speakers.
  add([0, -boomH * 0.18, zFace], boomH * 0.15, playColor);
  add([0, boomH * 0.2, zFace], boomH * 0.13, redColor);

  // Carry handle arcing over the top.
  const handleSteps = 7;
  const topY = -boomH * 0.5;
  for (let i = 0; i <= handleSteps; i++) {
    const t = i / handleSteps;
    const ang = Math.PI * t;
    add(
      [Math.cos(ang) * boomW * 0.36, topY - Math.sin(ang) * boomH * 0.55, 0],
      boomH * 0.11,
      handleColor,
    );
  }

  // --- Box centre: auto corner placement + user offsets ---
  // Sits on the ground in the bottom-left or bottom-right corner. Its part is
  // "ground", so the renderer keeps it fixed while the creature spins.
  const bz = -boomD * 0.8;
  const by = maxY - boomH * 0.5 + config.offsetY;
  const bx = groundCornerX(
    cols,
    side,
    boomW * 0.5,
    bodyR,
    zFace,
    bz,
    config.offsetX,
  );

  const yawDeg = side === "left" ? config.yawDeg : -config.yawDeg;
  const yaw = (yawDeg * Math.PI) / 180;

  return local.map((ls) => {
    const r = rotY(ls.c, yaw);
    return {
      center: [bx + r[0], by + r[1], bz + r[2]] as V3,
      radius: ls.r,
      zone: "wearable" as const,
      part: "ground",
      color: ls.color,
    };
  });
}

const SPIRIT_ORB_YAW_DEG = 45;

/** A small round spirit with two eyes, resting near the herzie's feet — the
 * Spirit Orb pet. Reuses the same eyeZ() surface-protrusion math and pupil
 * offset as the herzie builder (buildHerzie), inlined here rather than via
 * addPupils/eye-sphere pushes since this builder returns a flat sphere array
 * (matching buildBoomboxSpheres' contract) instead of mutating in place. */
function buildSpiritOrbSpheres(
  spheres: Sphere[],
  cols: number,
  side: GroundSide,
): Sphere[] {
  if (spheres.length === 0) return [];

  // Hovers a fixed height above the floor (see PET_HOVER_HEIGHT), so it
  // stays put whatever the herzie's size or stage.
  const midY = petHoverY(spheres);

  const bodyColor = "#c9b8ff";
  const eyeColor = "#1a1a2e";
  const pupilColor = "#000000";

  // Fixed world-space size, same basis as the boombox, but clearly smaller —
  // reads as a small round "spirit", not a companion-sized creature. Just big
  // enough that its eyes resolve as distinct pixels.
  const orbR = BOOMBOX_REF_HEIGHT * 0.18;
  const eyeR = orbR * 0.28;
  const eyeX = orbR * 0.38;
  const eyeY = -orbR * 0.1;
  const ez = eyeZ(orbR, eyeX, eyeY, eyeR);
  const pupilR = eyeR * 0.32;
  const pupilZOff = -eyeR * 0.85;

  interface LocalSphere {
    c: V3;
    r: number;
    color: string;
  }
  const local: LocalSphere[] = [
    { c: [0, 0, 0], r: orbR, color: bodyColor },
    { c: [-eyeX, eyeY, ez], r: eyeR, color: eyeColor },
    { c: [eyeX, eyeY, ez], r: eyeR, color: eyeColor },
    { c: [-eyeX, eyeY, ez + pupilZOff], r: pupilR, color: pupilColor },
    { c: [eyeX, eyeY, ez + pupilZOff], r: pupilR, color: pupilColor },
  ];

  return placeCompanion(local, midY, orbR, cols, side, "spirit");
}

/**
 * Places a companion (a pet, or a small ground prop), built around
 * its own origin, beside the herzie at height `y`.
 *
 * Horizontal placement reuses the same bottom-corner scheme as the boombox
 * (still respects left/right slot + camera-FOV margin math). The part decides
 * how it moves: all three keep it fixed while the herzie is manually
 * rotated; "spirit" (the Greedy Spirit, which also hops when dancing) and
 * "pet" get a slow breathing bob (see applyIdleOffsets), while "ground"
 * stays on the floor and bounces with the boombox on the beat.
 */
function placeCompanion(
  local: readonly { c: V3; r: number; color: string }[],
  y: number,
  size: number,
  cols: number,
  side: GroundSide,
  part: "spirit" | "pet" | "ground",
  /** Turn it slightly toward the herzie, so it reads as watching over it
   * rather than staring at the camera. Off for things that should face front. */
  faceHerzie = true,
): Sphere[] {
  const bz = -size * 1.6;
  const bx = groundCornerX(cols, side, size, size, -size, bz, 0.1);

  // Same sign convention as the boombox's yaw.
  const yawDeg = !faceHerzie
    ? 0
    : side === "left"
      ? -SPIRIT_ORB_YAW_DEG
      : SPIRIT_ORB_YAW_DEG;
  const yaw = (yawDeg * Math.PI) / 180;

  return local.map((ls) => {
    const r = rotY(ls.c, yaw);
    return {
      center: [bx + r[0], y + r[1], bz + r[2]] as V3,
      radius: ls.r,
      zone: "wearable" as const,
      part,
      color: ls.color,
    };
  });
}

/** How high above the floor (the herzie's feet) floating pets hover, in the
 * same fixed world units as the boombox — so a pet sits at the same height on
 * a stage-1 herzie as a stage-3 one, rather than tracking its midpoint. */
const PET_HOVER_HEIGHT = BOOMBOX_REF_HEIGHT * 1.2;

/** The floor: the lowest point of everything so far (the herzie's feet). */
function floorY(spheres: Sphere[]): number {
  let floor = -Infinity;
  for (const s of spheres) floor = Math.max(floor, s.center[1] + s.radius);
  return floor;
}

/** Where a floating pet's centre goes: PET_HOVER_HEIGHT above the feet.
 * World +y points down the screen. */
function petHoverY(spheres: Sphere[]): number {
  return floorY(spheres) - PET_HOVER_HEIGHT;
}

/** A sheet ghost: a round head over a body that flares out to a wavy hem. */
function buildGhostSpheres(
  spheres: Sphere[],
  cols: number,
  side: GroundSide,
): Sphere[] {
  if (spheres.length === 0) return [];
  const R = BOOMBOX_REF_HEIGHT * 0.2;
  const sheet = "#F2F2FA";
  const shade = "#D8D8E6";
  const headR = R * 0.75;
  const headY = -R * 0.45;
  const local: { c: V3; r: number; color: string }[] = [
    { c: [0, headY, 0], r: headR, color: sheet },
    { c: [0, R * 0.15, 0], r: R * 0.72, color: sheet },
    { c: [0, R * 0.55, 0], r: R * 0.74, color: sheet },
  ];
  // Wavy hem: lobes alternating up and down around the bottom edge.
  const lobes = 10;
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2;
    local.push({
      c: [
        Math.cos(a) * R * 0.62,
        R * 0.95 + (i % 2 === 0 ? R * 0.1 : -R * 0.02),
        Math.sin(a) * R * 0.62,
      ],
      r: R * 0.24,
      color: i % 2 === 0 ? sheet : shade,
    });
  }
  const eyeR = R * 0.16;
  const ex = R * 0.27;
  const ey = -R * 0.12; // relative to the head
  const ez = eyeZ(headR, ex, ey, eyeR);
  local.push({ c: [-ex, headY + ey, ez], r: eyeR, color: "#1A1A2E" });
  local.push({ c: [ex, headY + ey, ez], r: eyeR, color: "#1A1A2E" });
  const mouthY = R * 0.22;
  local.push({
    c: [0, headY + mouthY, eyeZ(headR, 0, mouthY, R * 0.1)],
    r: R * 0.1,
    color: "#1A1A2E",
  });
  return placeCompanion(local, petHoverY(spheres), R, cols, side, "pet");
}

/** Pointed witch hat: a brim, an orange band, and a cone of shrinking
 * spheres whose top bends over. The bent tip carries dangle weights, so it
 * swings round the hat's axis when the herzie is spun (see applyDangle). */
function buildWitchHatSpheres(spheres: Sphere[]): Sphere[] {
  const head = getHeadBounds(spheres);
  if (!head) return [];
  const [hx, hy, hz] = head.center;
  const hr = head.radius;
  const felt = "#6B4A94";
  const result: Sphere[] = [];
  const push = (c: V3, r: number, color: string, dangle?: Dangle) =>
    result.push({
      center: c,
      radius: r,
      zone: "wearable",
      part: "head",
      color,
      dangle,
    });

  // Brim: a wide ring resting on the crown, with a band just above it.
  const brimY = hy - hr * 0.62;
  const ring = (
    steps: number,
    y: number,
    radius: number,
    r: number,
    color: string,
  ) => {
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      push([hx + Math.cos(a) * radius, y, hz + Math.sin(a) * radius], r, color);
    }
  };
  ring(22, brimY, hr * 0.9, hr * 0.16, felt);
  ring(16, brimY - hr * 0.16, hr * 0.6, hr * 0.15, "#F27B13");

  // Cone: straight for most of its height, then the top bends over to one
  // side and droops a little. Squat on purpose: a grown herzie's head sits
  // close to the top of the frame, and a classic tall hat would be cut off.
  const steps = 9;
  const bendFrom = 5;
  const height = hr * 0.85;
  let x = hx;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    let y = brimY - hr * 0.15 - t * height;
    let dangle: Dangle | undefined;
    if (i >= bendFrom) {
      const k = (i - bendFrom + 1) / (steps - bendFrom);
      x += hr * 0.2 * k;
      y += hr * 0.08 * k * k;
      dangle = { weight: k, hang: 0, pivot: [hx, hz] };
    }
    push([x, y, hz], hr * (0.58 - 0.48 * t), felt, dangle);
  }
  return result;
}

/** Two small fangs on the front of the head, just below the eyes. */
function buildFangSpheres(spheres: Sphere[]): Sphere[] {
  const head = largestPart(spheres, "head");
  const eyes = spheres.filter((s) => s.part === "eye");
  if (!head || eyes.length < 2) return [];
  const [hx, hy, hz] = head.center;
  const er = Math.min(...eyes.map((e) => e.radius));
  const eyeBottom = Math.max(...eyes.map((e) => e.center[1] + e.radius));
  const spread = Math.abs(eyes[0].center[0] - eyes[1].center[0]) * 0.22;
  const result: Sphere[] = [];
  for (const side of [-1, 1]) {
    const fx = side * spread;
    // A larger root with a smaller tip below it, so each reads as a point.
    for (const [dy, r] of [
      [er * 0.9, er * 0.32],
      [er * 1.3, er * 0.2],
    ] as const) {
      const y = eyeBottom + dy - hy;
      result.push({
        center: [hx + fx, hy + y, hz + eyeZ(head.radius, fx, y, r)],
        radius: r,
        zone: "wearable",
        part: "head",
        color: "#FFFFFF",
      });
    }
  }
  return result;
}

/** Whether the Greedy Spirit is the worn spirit. */
export function hasSpiritEquipped(equipped?: Equipped): boolean {
  return equipped?.spirit === "spirit-orb";
}

/** Which side the worn spirit floats on. It has a slot of its own rather than
 * a ground side, so it always takes the same one, hovering above whatever
 * accessory stands there. */
const SPIRIT_SIDE: GroundSide = "right";

export function equippedCacheKey(equipped?: Equipped): string {
  if (!equipped) return "";
  // Derived from EQUIPPED_SLOTS so a new slot can never silently miss the key
  // and serve stale frames after equipping. `modifier` lives outside
  // EQUIPPED_SLOTS (it's an unbounded array, not a single-value slot) so it's
  // folded in separately, sorted for a stable key regardless of equip order.
  const slots = EQUIPPED_SLOTS.map((s) => `${s}:${equipped[s] ?? ""}`).join(
    ",",
  );
  const modifiers = [...(equipped.modifier ?? [])].sort().join("+");
  return `${slots},modifier:${modifiers}`;
}

function appendWearableSpheres(
  spheres: Sphere[],
  equipped: Equipped | undefined,
  cols: number,
  boomboxConfig?: BoomboxConfig,
): void {
  if (!equipped) return;

  if (equipped.face === "fangs") {
    spheres.push(...buildFangSpheres(spheres));
  }
  if (equipped.head === "headphones") {
    spheres.push(...buildHeadphoneSpheres(spheres));
  }
  if (equipped.head === "witch-hat") {
    spheres.push(...buildWitchHatSpheres(spheres));
  }
  if (equipped.head === "rainbow-headband") {
    spheres.push(...buildRainbowHeadbandSpheres(spheres));
  }
  const bodyBuilder = equipped.body && BODY_ITEM_BUILDERS[equipped.body];
  if (bodyBuilder) spheres.push(...bodyBuilder(spheres));

  for (const side of ["left", "right"] as const) {
    const itemId = equipped[groundSlot(side)];
    if (itemId === "boombox") {
      spheres.push(...buildBoomboxSpheres(spheres, cols, side, boomboxConfig));
    }
  }

  if (equipped.spirit === "spirit-orb") {
    spheres.push(...buildSpiritOrbSpheres(spheres, cols, SPIRIT_SIDE));
  } else if (equipped.spirit === "ghost") {
    spheres.push(...buildGhostSpheres(spheres, cols, SPIRIT_SIDE));
  }
}

/**
 * Equipable colour schemes, keyed by item id. A scheme replaces the herzie's
 * seeded body colour with a vertical gradient; the seed itself is untouched,
 * so unequipping restores the original creature.
 */
/** Colour-scheme key for Good ol' George's solid-gold body. It lives in the
 * `color` slot like a skin, but no catalog item has this id. */
export const GOLD_SCHEME_ID = "npc-gold";
/** Colour-scheme key for Nandor the Treatless, the same arrangement as
 * GOLD_SCHEME_ID. */
export const NANDOR_SCHEME_ID = "npc-nandor";

const COLOR_SCHEMES: Record<string, readonly string[]> = {
  prism: RAINBOW_RAMP,
  "poseidons-gift": OCEAN_RAMP,
  // Both ramps are built around a CREATURE_PALETTE entry (soft violet and
  // teal), so these two paint a herzie a colour it could already have
  // hatched with rather than introducing a new one.
  "purple-dane": VIOLET_RAMP,
  "thanks-for-all-the-fish": TEAL_RAMP,
  "pumpkin-spice": PUMPKIN_RAMP,
  // Not an item: Good ol' George's gold, applied only by the desktop's
  // Events emblem (see GOLD_SCHEME_ID). No player can equip it.
  [GOLD_SCHEME_ID]: GOLD_RAMP,
  [NANDOR_SCHEME_ID]: NANDOR_RAMP,
};

/** True for spheres that a colour scheme is allowed to repaint. */
function isSchemePaintable(zone: ColorZone, hasOwnColor: boolean): boolean {
  return (
    !hasOwnColor &&
    zone !== "eye" &&
    zone !== "eye-evil" &&
    zone !== "pupil" &&
    zone !== "wearable"
  );
}

/**
 * Resolve the ramp for whatever colour scheme is equipped, if any.
 *
 * A boss always paints with VOID_RAMP and ignores equipped colour items: its
 * palette is part of what it *is*, not a skin over a seeded body colour. This
 * is also why the boss needs no entry in CREATURE_PALETTE — adding one there
 * would shift `colorIndex` for every existing seed, the same trap as bodyType.
 */
function colorSchemeFor(
  equipped?: Equipped,
  params?: CreatureParams,
): readonly string[] | undefined {
  if (params?.bodyType === BOSS_BODY_TYPE) return VOID_RAMP;
  const id = equipped?.color;
  if (!id) return undefined;
  const ramp = COLOR_SCHEMES[id];
  return ramp && ramp.length > 0 ? ramp : undefined;
}

/** The creature's spheres in world space, before rendering. Exported so tests
 * can assert on the geometry itself rather than on rendered cells. */
export function buildCreatureSpheres(
  params: CreatureParams,
  stage: number,
): Sphere[] {
  const spheres = BODY_BUILDERS[params.bodyType](params, stage);
  centerVertically(spheres);
  return spheres;
}

// --- Greedy Spirit dance hops ---
// While dancing, the spirit every so often hops along to the music, so it
// reads as alive rather than as a prop on a sine wave. A hop baked into the
// loop would recur on the exact same beat forever, which is the opposite of
// alive, so hops live in separate loop *variants* instead: identical to the
// plain dance loop except for the spirit during its hop(s). Herzie3D picks
// plain or a random variant at each loop boundary, so hops land at irregular
// times, heights and spacings. A variant only re-renders the frames its hops
// touch and shares the rest with the plain loop (see generateLoopFrames).
//
// Hops are snappy and locked to the beat: they launch as the boombox touches
// down and land on a later touchdown, sometimes chaining beat to beat.

interface SpiritHop {
  /** Frame the crouch starts on. */
  start: number;
  /** Apex height above rest, in world units (~11 terminal rows per unit). */
  height: number;
  crouch: number; // frames
  air: number; // frames
  settle: number; // frames
  /** Sideways distance covered, toward the herzie (negative = away). It is
   * kept after landing, so a variant's travels must sum to zero. Columns are
   * about twice as dense as rows (~24 per unit), so a little goes a long way. */
  travel: number;
  /** Degrees the spirit turns toward the herzie (negative = toward the
   * camera) to look where it is going, then eases back after landing. */
  turn: number;
}

interface HopOptions {
  travel?: number;
  turn?: number;
}

const HOP_CROUCH_DEPTH = 0.25; // of height
const HOP_SETTLE_DEPTH = 0.5; // of height, before the sin·(1-p) shaping

/** Boombox touchdowns — the beat — fall every DANCE_BEAT frames (390ms). */
const DANCE_BEAT = DANCE_FRAMES / (2 * DANCE.ground.cycles);

/** A dance hop that leaves the ground on beat `launchBeat` and lands `beats`
 * later, with a one-frame crouch just before the beat. `rebound` drops the
 * landing so the next hop can push straight off it. */
function danceHop(
  launchBeat: number,
  beats: number,
  height: number,
  {
    travel = 0,
    turn = 0,
    rebound = false,
  }: HopOptions & { rebound?: boolean } = {},
): SpiritHop {
  return {
    start: launchBeat * DANCE_BEAT - 1,
    height,
    crouch: 1,
    air: beats * DANCE_BEAT,
    settle: rebound ? 0 : 2,
    travel,
    turn,
  };
}

// Launches never sit on beat 0: every variant must match the plain loop on its
// first and last frame so swapping at the wrap is seamless.
const DANCE_SPIRIT_HOPS: readonly (readonly SpiritHop[])[] = [
  // Heights run higher than idle hops: the dance float already swings the
  // spirit about a row either way, and a smaller hop just disappears into it.
  [danceHop(1, 1, 0.2)],
  [danceHop(1, 2, 0.34)],
  [danceHop(2, 1, 0.24)],
  // Bouncing along: two quick hops, the second a touch higher.
  [danceHop(1, 1, 0.18, { rebound: true }), danceHop(2, 1, 0.24)],
  // Little hop, then a big one off the rebound.
  [danceHop(1, 1, 0.14, { rebound: true }), danceHop(2, 1, 0.32)],
  // Side-step: over toward the herzie on one beat, back out on the next.
  [
    danceHop(1, 1, 0.2, { travel: 0.08, turn: 10, rebound: true }),
    danceHop(2, 1, 0.2, { travel: -0.08, turn: -25 }),
  ],
];

/** Dance hop variants Herzie3D can choose between (indices 0..n-1). */
export const SPIRIT_DANCE_HOP_VARIANT_COUNT = DANCE_SPIRIT_HOPS.length;

function spiritHopsFor(
  variant: number | undefined,
): readonly SpiritHop[] | undefined {
  return variant === undefined ? undefined : DANCE_SPIRIT_HOPS[variant];
}

/** The glance leads the jump: it starts turning at least this many frames
 * before launch, and takes at least this long to ease back after landing. */
const HOP_TURN_LEAD = 3;

function hopLaunch(hop: SpiritHop): number {
  return hop.start + hop.crouch;
}

function hopLanding(hop: SpiritHop): number {
  return hopLaunch(hop) + hop.air;
}

/** First frame this hop moves anything. */
function hopFirstFrame(hop: SpiritHop): number {
  return hop.turn
    ? Math.min(hop.start, hopLaunch(hop) - HOP_TURN_LEAD)
    : hop.start;
}

/** One past the last frame this hop moves anything. Travel persists beyond
 * it, which isSpiritHopFrame accounts for by spanning the whole variant. */
function hopEndFrame(hop: SpiritHop): number {
  const release = hop.turn ? Math.max(hop.settle, HOP_TURN_LEAD) : hop.settle;
  return hopLanding(hop) + release;
}

/** Hermite ease-in-out, clamped to 0..1. */
function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/**
 * Height of one hop above rest at `frameIdx` (positive = up), 0 outside it.
 * Three phases, in the classic squash-and-stretch shape minus the squash
 * (spheres can't):
 *
 *   crouch  ease-in-out dip — the anticipation that sells the jump
 *   air     ballistic parabola from the crouch to rest: fast launch, slow
 *           hang at the apex, accelerating fall (gravity, not an easing)
 *   settle  the landing carries it below rest, then it springs back:
 *           sin(πp)·(1-p) starts moving downward like the fall and eases
 *           into rest with no velocity, so there is no pop on either end
 *
 * Air and settle sample mid-frame so no frame sits exactly on a boundary value.
 */
function hopHeight(frameIdx: number, hop: SpiritHop): number {
  const t = frameIdx - hop.start;
  const crouch = hop.height * HOP_CROUCH_DEPTH;
  if (t < 0 || t >= hop.crouch + hop.air + hop.settle) return 0;
  if (t < hop.crouch) {
    const p = (t + 1) / hop.crouch;
    return (-crouch * (1 - Math.cos(Math.PI * p))) / 2;
  }
  if (t < hop.crouch + hop.air) {
    const p = (t - hop.crouch + 0.5) / hop.air;
    return -crouch * (1 - p) + 4 * hop.height * p * (1 - p);
  }
  const p = (t - hop.crouch - hop.air + 0.5) / hop.settle;
  return -hop.height * HOP_SETTLE_DEPTH * Math.sin(Math.PI * p) * (1 - p);
}

/** Fraction of `hop.travel` covered by `frameIdx`. Linear through the air —
 * horizontal speed is constant in a ballistic jump, and paired with the
 * vertical parabola that traces a true arc. */
function hopTravel(frameIdx: number, hop: SpiritHop): number {
  const t = frameIdx - hopLaunch(hop);
  if (t < 0) return 0;
  if (t >= hop.air) return 1;
  return (t + 0.5) / hop.air;
}

/** 0..1 weight of `hop.turn` at `frameIdx`: eases in before launch (it looks
 * first, then jumps), holds through the air, eases out after landing. */
function hopTurn(frameIdx: number, hop: SpiritHop): number {
  const first = hopFirstFrame(hop);
  const launch = hopLaunch(hop);
  const landing = hopLanding(hop);
  const end = hopEndFrame(hop);
  if (frameIdx < first || frameIdx >= end) return 0;
  if (frameIdx < launch)
    return smoothstep((frameIdx - first + 1) / (launch - first));
  if (frameIdx < landing) return 1;
  return 1 - smoothstep((frameIdx - landing + 1) / (end - landing));
}

interface SpiritPose {
  /** World units above rest. */
  up: number;
  /** World units toward the herzie. */
  travel: number;
  /** Degrees toward the herzie. */
  turn: number;
}

function spiritPose(frameIdx: number, hops: readonly SpiritHop[]): SpiritPose {
  const pose = { up: 0, travel: 0, turn: 0 };
  for (const hop of hops) {
    pose.up += hopHeight(frameIdx, hop);
    pose.travel += hop.travel * hopTravel(frameIdx, hop);
    pose.turn += hop.turn * hopTurn(frameIdx, hop);
  }
  return pose;
}

/** Whether `frameIdx` differs from the plain dance loop in hop variant `variant`:
 * anywhere from its first hop's glance to its last hop's settle, gaps
 * included, since travel holds the spirit off its rest spot in between. */
export function isSpiritHopFrame(variant: number, frameIdx: number): boolean {
  const hops = spiritHopsFor(variant);
  if (!hops || hops.length === 0) return false;
  const first = Math.min(...hops.map(hopFirstFrame));
  const end = Math.max(...hops.map(hopEndFrame));
  return frameIdx >= first && frameIdx < end;
}

/**
 * Moves every Greedy Spirit sphere by the loop's bob plus its hop pose. The
 * turn rotates the spheres about the orb's own centre, so the eyes swing
 * round the body rather than the whole spirit orbiting. With no hops this is
 * exactly the plain bob (a zero-angle rotY is the identity).
 */
function spiritMover(
  spheres: Sphere[],
  frameIdx: number,
  hops: readonly SpiritHop[],
  bob: number,
): (s: Sphere) => Sphere {
  const pose = spiritPose(frameIdx, hops);
  let core: Sphere | undefined;
  for (const s of spheres) {
    if (s.part === "spirit" && (!core || s.radius > core.radius)) core = s;
  }
  const [cx, , cz] = core?.center ?? [0, 0, 0];
  // The herzie is centred on x = 0; the spirit sits to one side of it.
  const toward = cx < 0 ? 1 : -1;
  // Same sign convention as the placement yaw in buildSpiritOrbSpheres.
  const yaw = (-toward * pose.turn * Math.PI) / 180;
  const dx = toward * pose.travel;
  // World +y points down the screen (the creature's feet are at maxY).
  const dy = bob - pose.up;
  return (s) => {
    const [rx, , rz] = rotY([s.center[0] - cx, 0, s.center[2] - cz], yaw);
    return {
      ...s,
      center: [cx + rx + dx, s.center[1] + dy, cz + rz] as V3,
    };
  };
}

// --- Idle animation offsets ---

/** Each sphere's idle Y offset for `frameIdx`, as a per-sphere delta so a
 * pose can blend it with the walk cycle (see renderCreaturePose). */
function idleDeltas(spheres: Sphere[], frameIdx: number): number[] {
  function offset(
    part: { amp: number; cycles: number },
    phase: number,
  ): number {
    return (
      Math.sin(2 * Math.PI * (frameIdx / IDLE_FRAMES) * part.cycles + phase) *
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
  const spiritOff = offset(IDLE.spirit, Math.PI / 5);

  return spheres.map((s) => {
    if (s.part === "spirit" || s.part === "pet") return spiritOff;
    if (s.part === "body") return bodyOff;
    if (s.part === "head") return headOff;
    if (s.part === "eye" || s.part === "pupil") return eyeOff;
    if (s.part === "ear") return earOff;
    if (s.part === "spike") return spikeOff;
    if (s.part === "arm-l" || s.part === "leg-l") return limbLOff;
    if (s.part === "arm-r" || s.part === "leg-r") return limbROff;
    return 0;
  });
}

// Returns a copy of the sphere list with per-part Y offsets applied.
function applyIdleOffsets(spheres: Sphere[], frameIdx: number): Sphere[] {
  const dy = idleDeltas(spheres, frameIdx);
  return spheres.map((s, i) => ({
    ...s,
    center: [s.center[0], s.center[1] + dy[i], s.center[2]] as V3,
  }));
}

// --- Walk animation offsets ---
// One walk cycle is two steps (left, then right), as a fraction 0..1. The
// host advances it by distance covered, not by time, so the feet never
// slide. Amplitudes are fractions of the herzie's body scale, so they fit a
// stage 1 head as well as a stage 3 body. Creature space: front is -z, up is
// -y.

const WALK = {
  /** Stage 3: how far a foot swings forward and back. The hip swings this
   * times WALK.hipShare, so the leg reads as pivoting from the body. */
  legSwing: 0.2,
  hipShare: 0.4,
  /** Stage 3: how high a foot lifts on its forward swing. */
  footLift: 0.14,
  /** Arms swing against the leg on their side. */
  armSwing: 0.14,
  /** Stage 3: the body rises as the legs pass each other, twice a cycle. */
  bodyBob: 0.05,
  /** Stages 1-2 (no legs): one hop per step… */
  hop: 0.2,
  /** …rocking onto each side in turn (radians, about the bottom)… */
  roll: 0.08,
  /** …with ears and spikes trailing the hop by this fraction of a cycle. */
  flopLag: 0.08,
} as const;

/** Parts anchored to the scene rather than the creature: they never walk. */
const isSceneFixed = (part: string) =>
  part === "ground" || part === "spirit" || part === "pet";

/** Each sphere's walk offset at `phase` (0..1 of a cycle), as a delta. */
function walkDeltas(spheres: Sphere[], phase: number, stage: number): V3[] {
  const s = HERZIE_BODY.scale * CS;
  const theta = 2 * Math.PI * phase;
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  const hasLegs = spheres.some((sp) => sp.part === "leg-l");

  if (hasLegs && stage >= 3) {
    // The lower sphere of each leg is the foot; the upper one the hip.
    const footY = (side: string) =>
      Math.max(
        ...spheres.filter((sp) => sp.part === side).map((sp) => sp.center[1]),
      );
    const footL = footY("leg-l");
    const footR = footY("leg-r");
    // Right runs half a cycle behind the left: sin/cos flip sign.
    const swing = (side: 1 | -1) => -side * sin * WALK.legSwing * s;
    const lift = (side: 1 | -1) => -Math.max(0, side * cos) * WALK.footLift * s;
    const bob = -Math.abs(cos) * WALK.bodyBob * s;

    return spheres.map((sp) => {
      if (isSceneFixed(sp.part)) return [0, 0, 0];
      if (sp.part === "leg-l" || sp.part === "leg-r") {
        const side = sp.part === "leg-l" ? 1 : -1;
        const foot = sp.center[1] === (side === 1 ? footL : footR);
        return foot
          ? [0, lift(side), swing(side)]
          : [0, 0, swing(side) * WALK.hipShare];
      }
      if (sp.part === "arm-l") return [0, bob, sin * WALK.armSwing * s];
      if (sp.part === "arm-r") return [0, bob, -sin * WALK.armSwing * s];
      return [0, bob, 0];
    });
  }

  // No legs: a waddle. A hop per step, rocking onto alternate sides.
  const hopAt = (t: number) =>
    -Math.abs(Math.sin(2 * Math.PI * t)) * WALK.hop * s;
  const hop = hopAt(phase);
  const flop = hopAt(phase - WALK.flopLag);
  const roll = sin * WALK.roll;
  // Rock about the bottom of the creature, so it pivots on its base.
  let bottom = Number.NEGATIVE_INFINITY;
  for (const sp of spheres) {
    if (!isSceneFixed(sp.part)) {
      bottom = Math.max(bottom, sp.center[1] + sp.radius);
    }
  }
  return spheres.map((sp) => {
    if (isSceneFixed(sp.part)) return [0, 0, 0];
    const [x, y] = sp.center;
    // Small-angle rotation about (0, bottom) in the x-y plane.
    const rx = -(y - bottom) * roll;
    const ry = x * roll;
    const dy = sp.part === "ear" || sp.part === "spike" ? flop : hop;
    let dz = 0;
    if (sp.part === "arm-l") dz = sin * WALK.armSwing * s;
    else if (sp.part === "arm-r") dz = -sin * WALK.armSwing * s;
    return [rx, dy + ry, dz];
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

/** Cache-key suffix for a camera zoom; empty at 1 so existing keys hold. */
function zoomKey(zoom: number): string {
  return zoom === 1 ? "" : `:z${zoom}`;
}

function rowsKey(rows: number): string {
  return rows === SH ? "" : `:r${rows}`;
}

/** The column count wearables are placed against. Props that sit at the
 * frame's edge (the boombox, a floating pet) are placed from `cols`, which
 * assumes the default SH rows; a finer grid has more of both for the same
 * view, so this scales its cols back to the default grid's. */
function layoutCols(cols: number, rows: number): number {
  return rows === SH ? cols : Math.round((cols * SH) / rows);
}

// --- Anchor projection (FOV-based) ---

function projectPoint(
  p: V3,
  cols: number,
  halfW: number,
  halfH: number,
  rows: number = SH,
): [number, number, number] {
  const relZ = p[2] + CAM;
  if (relZ <= 0.01) return [cols / 2, rows / 2, 0];
  const ndcX = p[0] / (relZ * halfW);
  const ndcY = p[1] / (relZ * halfH);
  return [(ndcX + 1) * 0.5 * cols, (ndcY + 1) * 0.5 * rows, relZ];
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
    case "eye-evil":
      // Unlike "eye", this one shades: a flat red disc read as a sticker, and
      // the falloff is what makes it look lit from inside.
      return brightness > 0.62
        ? EVIL_EYE_BRIGHT
        : brightness > 0.34
          ? EVIL_EYE_BASE
          : EVIL_EYE_DIM;
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
  colorScheme?: readonly string[],
  zoom = 1,
  /** A camera pitch (radians, positive looks down on the herzie), applied
   * after the turn like a real camera's elevation. Omitted, the fixed
   * DEFAULT_CAMERA_TILT_DEG tilt applies before the turn, as it always has. */
  pitch?: number,
  /** Rows in the grid (default SH). Scaling rows and cols together keeps the
   * framing and only changes the resolution. */
  rows: number = SH,
): FrameData {
  // Zooming widens (or narrows) the view plane about its centre: the camera
  // sees more of the scene through the same grid of cells.
  const halfW = halfWidthFor(cols, rows) / zoom;
  const halfH = HALF_H / zoom;
  const pitchCos = pitch === undefined ? 1 : Math.cos(pitch);
  const pitchSin = pitch === undefined ? 0 : Math.sin(pitch);
  const transformed = spheres.map((s) => {
    if (pitch !== undefined) {
      const fixed =
        s.part === "ground" || s.part === "spirit" || s.part === "pet";
      const turned = fixed ? s.center : rotY(s.center, yAngle);
      return {
        center: [
          turned[0],
          turned[1] * pitchCos - turned[2] * pitchSin,
          turned[1] * pitchSin + turned[2] * pitchCos,
        ] as V3,
        radius: s.radius,
        zone: s.zone,
        part: s.part,
        color: s.color,
      };
    }
    const tilted: V3 = [
      s.center[0],
      s.center[1] * TILT_COS - s.center[2] * TILT_SIN,
      s.center[1] * TILT_SIN + s.center[2] * TILT_COS,
    ];
    // Ground props (e.g. the boombox) and the Spirit Orb ("spirit") are both
    // anchored to the scene, not the creature — they keep their facing as the
    // herzie spins around its Y axis (manual drag-rotation shouldn't drag the
    // orb along with it). The orb gets its own independent breathing bob
    // instead, via applyIdleOffsets.
    const isFixed =
      s.part === "ground" || s.part === "spirit" || s.part === "pet";
    return {
      center: isFixed ? tilted : rotY(tilted, yAngle),
      radius: s.radius,
      zone: s.zone,
      part: s.part,
      color: s.color,
    };
  });

  const bright: number[][] = Array.from({ length: rows }, () =>
    Array(cols).fill(-1),
  );
  const zones: ColorZone[][] = Array.from({ length: rows }, () =>
    Array<ColorZone>(cols).fill("primary"),
  );
  const pixelColors: (string | null)[][] = Array.from({ length: rows }, () =>
    Array(cols).fill(null),
  );

  // Surface extent of the scheme-painted body, measured in tilted space. rotY
  // preserves Y, so these bounds — and every hue derived from them — hold
  // steady as the herzie spins.
  let schemeYMin = Number.POSITIVE_INFINITY;
  let schemeYMax = Number.NEGATIVE_INFINITY;
  if (colorScheme) {
    for (const sp of transformed) {
      if (!isSchemePaintable(sp.zone, Boolean(sp.color))) continue;
      if (sp.center[1] - sp.radius < schemeYMin) {
        schemeYMin = sp.center[1] - sp.radius;
      }
      if (sp.center[1] + sp.radius > schemeYMax) {
        schemeYMax = sp.center[1] + sp.radius;
      }
    }
  }
  const schemeSpan = Math.max(1e-6, schemeYMax - schemeYMin);

  const oz = -CAM;

  for (let sy = 0; sy < rows; sy++) {
    for (let sx = 0; sx < cols; sx++) {
      const ndcX = ((sx + 0.5) / cols) * 2 - 1;
      const ndcY = ((sy + 0.5) / rows) * 2 - 1;
      const px = ndcX * halfW;
      const py = ndcY * halfH;
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
        // Pupils are colour-driven, not ramp-driven: RAMP_HERZIE is a single
        // glyph, so 1/(length-1) divided by zero and produced an undefined
        // glyph that canvas drew as the literal string "undefined".
        lit = 0;
      } else if (sp.zone === "eye") {
        lit = 0.75 * (0.15 + 0.85 * diffuse);
      } else if (sp.zone === "eye-evil") {
        // Biased high and compressed, so the eye stays hot even on the face's
        // shadow side — it should read as emitting, not as reflecting LIGHT.
        lit = 0.55 + 0.45 * diffuse;
      } else if (sp.color) {
        // Wearables keep clean shading — skip creature texture patterns.
        lit = 0.7 * (0.3 + 0.7 * diffuse);
      } else {
        const baseBright = 0.5 + applyTexture(textureType, nx, ny, nz);
        lit = baseBright * (0.15 + 0.85 * diffuse);
      }
      bright[sy][sx] = lit;
      zones[sy][sx] = sp.zone;
      if (sp.color) {
        pixelColors[sy][sx] = sp.color;
      } else if (
        colorScheme &&
        isSchemePaintable(sp.zone, false) &&
        schemeYMax > schemeYMin
      ) {
        // Hue comes from where the ray actually struck the surface, so the
        // head and body — each a single large sphere — carry a gradient
        // instead of one flat colour apiece.
        const t = (hy - schemeYMin) / schemeSpan;
        const band = Math.min(
          colorScheme.length - 1,
          Math.max(0, Math.floor(t * colorScheme.length)),
        );
        pixelColors[sy][sx] = colorScheme[band];
      }
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
    // Ground props stay fixed while the creature spins, so their anchors must
    // skip the Y-rotation too (otherwise they'd drift off the prop).
    const isFixed = anchor.parentPart === "ground";
    const rotated = isFixed ? tilted : rotY(tilted, yAngle);
    const [screenX, screenY, depth] = projectPoint(
      rotated,
      cols,
      halfW,
      halfH,
      rows,
    );

    const nTilted: V3 = [
      anchor.normalDir[0],
      anchor.normalDir[1] * TILT_COS - anchor.normalDir[2] * TILT_SIN,
      anchor.normalDir[1] * TILT_SIN + anchor.normalDir[2] * TILT_COS,
    ];
    const nRotated = isFixed ? nTilted : rotY(nTilted, yAngle);
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
 * An array of `length` frames, each rendered the first time it's read and
 * kept from then on. Rendering a whole loop up front cost 40–90ms per new
 * look — every equip or unequip stalled on it before the herzie could show
 * the change — when the first frame alone is under a millisecond. Lazily, the
 * rest cost one frame's render per animation tick, the first time round.
 *
 * Still a real array (length, indexing, iteration all work), so callers and
 * the cache see no difference.
 */
function lazyFrames(
  length: number,
  render: (i: number) => FrameData,
): FrameData[] {
  const frames = new Array<FrameData>(length);
  for (let i = 0; i < length; i++) {
    Object.defineProperty(frames, i, {
      configurable: true,
      enumerable: true,
      get() {
        const frame = render(i);
        Object.defineProperty(frames, i, {
          value: frame,
          enumerable: true,
        });
        return frame;
      },
    });
  }
  return frames;
}

/**
 * Idle or dance loop, the dance loop optionally as a Greedy Spirit hop
 * variant. With a variant, frames outside its hops are the plain loop's own
 * objects, so a variant costs only the handful of frames it re-renders. The
 * variant is ignored for the idle loop and when no spirit is equipped.
 */
function generateLoopFrames(
  mode: "idle" | "dance",
  userId: string,
  stage: number,
  equipped: Equipped | undefined,
  paramsOverride: CreatureParams | undefined,
  cols: number,
  boomboxConfig: BoomboxConfig | undefined,
  spiritHopVariant: number | undefined,
  zoom: number,
  rows: number = SH,
): FrameData[] {
  const dancing = mode === "dance";
  const hops =
    dancing && hasSpiritEquipped(equipped)
      ? spiritHopsFor(spiritHopVariant)
      : undefined;
  const key = `${mode}:${paramsCacheKey(userId, paramsOverride)}:${stage}:${equippedCacheKey(equipped)}:${cols}:${boomboxKey(boomboxConfig)}${hops ? `:hop${spiritHopVariant}` : ""}${zoomKey(zoom)}${rowsKey(rows)}`;
  const cached = frameCache.get(key);
  if (cached) return cached;

  const plain = hops
    ? generateLoopFrames(
        mode,
        userId,
        stage,
        equipped,
        paramsOverride,
        cols,
        boomboxConfig,
        undefined,
        zoom,
        rows,
      )
    : undefined;

  const params = resolveCreatureParams(userId, paramsOverride);
  const baseSpheres = buildCreatureSpheres(params, stage);
  appendWearableSpheres(
    baseSpheres,
    equipped,
    layoutCols(cols, rows),
    boomboxConfig,
  );
  const anchors = getAnchors(baseSpheres, params, stage);
  const colors = buildColorTriplet(CREATURE_PALETTE[params.colorIndex]);
  const scheme = colorSchemeFor(equipped, params);

  const length = dancing ? DANCE_FRAMES : IDLE_FRAMES;
  const frames = lazyFrames(length, (i) => {
    if (plain && !isSpiritHopFrame(spiritHopVariant as number, i)) {
      return plain[i];
    }
    const animated = dancing
      ? applyDanceOffsets(baseSpheres, i, hops)
      : applyIdleOffsets(baseSpheres, i);
    return renderCreatureFrame(
      animated,
      DEFAULT_Y_ANGLE,
      params.textureType,
      anchors,
      colors,
      cols,
      scheme,
      zoom,
      undefined,
      rows,
    );
  });

  frameCache.set(key, frames);
  return frames;
}

/**
 * Generate idle animation frames — fixed Y angle with per-part breathing offsets.
 * 120 frames at 50ms = 6s loop.
 */
export function generateIdleFrames(
  userId: string,
  stage: number,
  equipped?: Equipped,
  paramsOverride?: CreatureParams,
  cols: number = SW,
  boomboxConfig?: BoomboxConfig,
  /** Camera zoom about the frame's centre (see renderCreatureFrame). */
  zoom = 1,
  /** Grid rows (see renderCreatureFrame): more rows and cols, finer. */
  rows: number = SH,
): FrameData[] {
  return generateLoopFrames(
    "idle",
    userId,
    stage,
    equipped,
    paramsOverride,
    cols,
    boomboxConfig,
    undefined,
    zoom,
    rows,
  );
}

/** How long each frame of the rotation loop shows, in ms (Herzie3D's tick). */
export const ROTATION_FRAME_MS = 80;

/** The steady trail and flare a dangling item holds through the rotation
 * loop: a spin of one turn per `frameCount` frames at ROTATION_FRAME_MS. */
export function rotationLoopDangle(frameCount = 36): DangleState {
  const speed = (Math.PI * 2) / ((frameCount * ROTATION_FRAME_MS) / 1000);
  return steadyDangle(speed, DEFAULT_DANGLE_CONFIG);
}

/**
 * Generate rotation animation frames — continuous Y-axis spin.
 * 36 frames at 80ms. Anything dangling holds the trail a steady spin gives it.
 */
export function generateRotationFrames(
  userId: string,
  stage: number,
  frameCount = 36,
  equipped?: Equipped,
  paramsOverride?: CreatureParams,
  cols: number = SW,
  boomboxConfig?: BoomboxConfig,
  zoom = 1,
  rows: number = SH,
): FrameData[] {
  const key = `rot:${paramsCacheKey(userId, paramsOverride)}:${stage}:${equippedCacheKey(equipped)}:${cols}:${boomboxKey(boomboxConfig)}${zoomKey(zoom)}${rowsKey(rows)}`;
  const cached = frameCache.get(key);
  if (cached) return cached;

  const params = resolveCreatureParams(userId, paramsOverride);
  const built = buildCreatureSpheres(params, stage);
  appendWearableSpheres(built, equipped, layoutCols(cols, rows), boomboxConfig);
  const spheres = applyDangle(built, rotationLoopDangle(frameCount));
  const anchors = getAnchors(spheres, params, stage);
  const colors = buildColorTriplet(CREATURE_PALETTE[params.colorIndex]);
  const scheme = colorSchemeFor(equipped, params);

  const frames = lazyFrames(frameCount, (i) =>
    renderCreatureFrame(
      spheres,
      (i / frameCount) * Math.PI * 2,
      params.textureType,
      anchors,
      colors,
      cols,
      scheme,
      zoom,
      undefined,
      rows,
    ),
  );

  frameCache.set(key, frames);
  return frames;
}

/**
 * Generate dance animation frames — rhythmic bounce at DEFAULT_Y_ANGLE.
 * 24 frames at 65ms = 1560ms loop.
 *
 * `spiritHopVariant` (0..SPIRIT_DANCE_HOP_VARIANT_COUNT-1) returns that
 * Greedy Spirit on-beat hop variant of the loop instead of the plain one.
 */
export function generateDanceFrames(
  userId: string,
  stage: number,
  equipped?: Equipped,
  paramsOverride?: CreatureParams,
  cols: number = SW,
  boomboxConfig?: BoomboxConfig,
  spiritHopVariant?: number,
  zoom = 1,
  rows: number = SH,
): FrameData[] {
  return generateLoopFrames(
    "dance",
    userId,
    stage,
    equipped,
    paramsOverride,
    cols,
    boomboxConfig,
    spiritHopVariant,
    zoom,
    rows,
  );
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
  equipped?: Equipped,
  paramsOverride?: CreatureParams,
  cols: number = SW,
  boomboxConfig?: BoomboxConfig,
  spiritHopVariant?: number,
  /** Pose for anything dangling, from Herzie3D's spin physics. */
  dangle?: DangleState,
  zoom = 1,
  rows: number = SH,
): FrameData {
  const params = resolveCreatureParams(userId, paramsOverride);
  const built = buildCreatureSpheres(params, stage);
  appendWearableSpheres(built, equipped, layoutCols(cols, rows), boomboxConfig);
  const baseSpheres = dangle ? applyDangle(built, dangle) : built;
  const anchors = getAnchors(baseSpheres, params, stage);
  const colors = buildColorTriplet(CREATURE_PALETTE[params.colorIndex]);
  const scheme = colorSchemeFor(equipped, params);
  const animated = dancing
    ? applyDanceOffsets(baseSpheres, frameIdx, spiritHopsFor(spiritHopVariant))
    : applyIdleOffsets(baseSpheres, frameIdx);
  return renderCreatureFrame(
    animated,
    yAngle,
    params.textureType,
    anchors,
    colors,
    cols,
    scheme,
    zoom,
    undefined,
    rows,
  );
}

/** A herzie's pose for renderCreaturePose: a blend of the idle loop and the
 * walk cycle, seen from a free camera. */
export interface CreaturePose {
  /** Turn about the vertical axis; 0 is square-on to the camera. */
  yAngle: number;
  /** Camera elevation in radians (see renderCreatureFrame's `pitch`). */
  pitch?: number;
  /** Frame of the idle loop, 0..IDLE_LOOP_FRAMES. */
  idleFrame: number;
  /** How far through a walk cycle (two steps), 0..1. */
  walkPhase: number;
  /** 0 standing (pure idle) to 1 walking (pure walk cycle). */
  walkWeight: number;
}

/** Frames in the idle loop, which Herzie3D plays at 50ms a frame. */
export const IDLE_LOOP_FRAMES = IDLE_FRAMES;

/** Built sphere lists for renderCreaturePose, which a host calls every
 * frame: building a creature and its wearables is pure, so it's done once
 * per look. Bounded, since every distinct look adds an entry. */
const poseBuildCache = new Map<
  string,
  {
    spheres: Sphere[];
    anchors: AnchorPoint[];
    colors: ColorTriplet;
    scheme: readonly string[] | undefined;
    textureType: number;
  }
>();
const POSE_BUILD_CACHE_MAX = 32;

/**
 * Renders a herzie in any pose a game needs: any turn and camera pitch, and
 * anywhere between standing (the idle loop) and walking (the walk cycle).
 * With `walkWeight: 0` and no pitch it draws exactly what
 * renderCreatureAtAngle draws for the same idle frame.
 */
export function renderCreaturePose(
  userId: string,
  stage: number,
  pose: CreaturePose,
  equipped?: Equipped,
  paramsOverride?: CreatureParams,
  cols: number = SW,
  /** Grid rows (default SH): more rows and cols, same framing, finer. */
  rows: number = SH,
): FrameData {
  const key = `${paramsCacheKey(userId, paramsOverride)}:${stage}:${equippedCacheKey(equipped)}:${cols}${rowsKey(rows)}`;
  let built = poseBuildCache.get(key);
  if (!built) {
    const params = resolveCreatureParams(userId, paramsOverride);
    const spheres = buildCreatureSpheres(params, stage);
    appendWearableSpheres(spheres, equipped, layoutCols(cols, rows));
    built = {
      spheres,
      anchors: getAnchors(spheres, params, stage),
      colors: buildColorTriplet(CREATURE_PALETTE[params.colorIndex]),
      scheme: colorSchemeFor(equipped, params),
      textureType: params.textureType,
    };
    if (poseBuildCache.size >= POSE_BUILD_CACHE_MAX) {
      const oldest = poseBuildCache.keys().next().value;
      if (oldest !== undefined) poseBuildCache.delete(oldest);
    }
    poseBuildCache.set(key, built);
  }

  const { spheres } = built;
  const w = Math.min(1, Math.max(0, pose.walkWeight));
  const idle = idleDeltas(spheres, pose.idleFrame);
  const walk = w > 0 ? walkDeltas(spheres, pose.walkPhase, stage) : null;
  const animated = spheres.map((s, i) => {
    // Scene-anchored parts (a floating pet) keep their own idle bob even
    // mid-stride; everything else fades from idle into the walk.
    const iw = walk && !isSceneFixed(s.part) ? 1 - w : 1;
    const d = walk?.[i];
    return {
      ...s,
      center: [
        s.center[0] + (d ? d[0] * w : 0),
        s.center[1] + idle[i] * iw + (d ? d[1] * w : 0),
        s.center[2] + (d ? d[2] * w : 0),
      ] as V3,
    };
  });
  return renderCreatureFrame(
    animated,
    pose.yAngle,
    built.textureType,
    built.anchors,
    built.colors,
    cols,
    built.scheme,
    1,
    pose.pitch,
    rows,
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
