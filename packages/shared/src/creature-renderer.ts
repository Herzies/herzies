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
  BOBOKU_RAMP,
  CHAR_ASPECT,
  dot3,
  GOLD_RAMP,
  LIGHT,
  MEDEA_RAMP,
  NANDOR_RAMP,
  OCEAN_RAMP,
  PUMPKIN_RAMP,
  RAINBOW_RAMP,
  RAMP_HERZIE,
  rotY,
  TEAL_RAMP,
  TOWER_GUARD_RAMP,
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
import { settleThread, type ThreadRig } from "./thread-physics.js";

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
/** The frame's full height at the herzie's centre, in creature units: what
 * a host drawing herzies in its own 3D space scales against. */
export const CREATURE_FRAME_HEIGHT = 2 * FRAME_HALF_H;

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

export interface ColorTriplet {
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
const IDLE_FRAMES = 120; // at 50ms per frame — a 6000ms loop

const IDLE = {
  body: { amp: 0.04, cycles: 4 }, // 1500ms
  head: { amp: 0.025, cycles: 2 }, // 3000ms
  eye: { amp: 0.025, cycles: 2 }, // follows head
  arm: { amp: 0.1, cycles: 4 }, // radians about the shoulder; 1500ms
  limb: { amp: 0.03, cycles: 4 }, // the boss's chained arms; 1500ms
  ear: { amp: 0.02, cycles: 2 }, // 3000ms
  spike: { amp: 0.015, cycles: 2 }, // follows ears
  // Spirit Orb — one slow breath across the whole loop, deliberately calmer
  // than any herzie part. It is the reason the loop is 6s rather than 3s.
  spirit: { amp: 0.04, cycles: 1 }, // 6000ms
} as const;

// --- Dance animation constants ---
const DANCE_FRAMES = 24;
// 65ms per frame → 1560ms loop (~77 BPM); interval applied by the animator.

const DANCE = {
  ground: { amp: 0.06, cycles: 2 }, // boombox hop — upward bounce on the beat
  spirit: { amp: 0.08, cycles: 1 }, // Spirit Orb — slow smooth float, not a hop
} as const;

/**
 * The herzie's own groove, in fractions of its body scale (lengths) and
 * radians (turns). Lags are fractions of a beat: each part follows the one
 * it hangs off a little late, as a loose thing would.
 */
const GROOVE = {
  /** With legs: the body sinks onto them on each beat, knees bending… */
  dip: 0.07,
  /** …and rocks over onto each foot in turn, once a loop, about the feet. */
  rock: 0.07,
  /** The foot it rocks off taps between beats; the other stays planted. */
  tap: 0.06,
  /** Without legs: a little hop between beats, landing on each one. */
  hop: 0.06,
  /** The head nods after the body. */
  nod: 0.035,
  nodLag: 0.12,
  /** Ears and spikes flop after the head. */
  flop: 0.05,
  flopLag: 0.25,
  /** The arms fly up after the dip and fall back… */
  armLift: 0.55,
  armLag: 0.2,
  /** …and swing forward and back, one each way, every two beats. */
  armSwing: 0.4,
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
  /** Absent, this is a sphere. Otherwise a solid around the segment from
   * center − axis to center + axis, `radius` thick: a capsule (rounded ends)
   * or a cylinder (flat ends). The axis is relative to the center, so the
   * animations, which only move centers, carry it along untouched; only
   * renderCreatureFrame's camera turn and applyDangle's swing rotate it. */
  shape?: Shape;
  /** Held class gear: the way from where it's slung (its center and axis)
   * to the hand. See heldPoses. */
  held?: HeldSocket;
  /** Polished metal (the cymbal): it mirrors the sky, and its lathe grooves
   * catch the sun in a bright bar across it. See herzieMaterial. */
  finish?: "metal";
}

export interface Shape {
  kind: "capsule" | "cylinder" | "cone";
  axis: V3;
  /** Cones only: the radius at the +axis end (`radius` is the −axis end's);
   * 0 comes to a point. The ends are flat. */
  tipRadius?: number;
  /** Cylinders only: how far the middle of each end bulges out past the rim,
   * as a paraboloid cap (an ear cup's domed face). Negative dishes it in. */
  dome?: number;
}

/** What the ray caster needs of a primitive. */
type Primitive = Pick<Sphere, "center" | "radius" | "shape">;

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

/** 1 on the beat, easing to 0 halfway between beats. */
function onBeat(phase: number): number {
  return ((1 + Math.cos(2 * Math.PI * phase)) / 2) ** 2;
}

/** How far through the current beat `frameIdx` is (0..1), `lag` beats
 * late. */
function beatPhase(frameIdx: number, lag = 0): number {
  const p = (frameIdx / DANCE_BEAT - lag) % 1;
  return p < 0 ? p + 1 : p;
}

/**
 * How high a herzie without legs is off the ground mid-dance, 0 (landing, on
 * the beat) to 1 (between beats): what a host squashes its landings by.
 */
export function danceHopLift(frameIdx: number): number {
  const p = beatPhase(frameIdx);
  return 4 * p * (1 - p);
}

/**
 * Each of the herzie's own spheres' dance offsets at `frameIdx`, as deltas.
 * The body leads; the head, ears and arms ride it and follow a little late.
 * With legs it stays on its feet: the body dips onto them on the beat and
 * rocks from foot to foot, one foot always planted. Without legs it hops,
 * landing on the beat. Scene-fixed parts (the boombox, a companion) aren't
 * moved here.
 */
function danceDeltas(spheres: Sphere[], frameIdx: number): V3[] {
  const s = HERZIE_BODY.scale * CS;
  const rig = buildRig(spheres);
  const t = frameIdx / DANCE_FRAMES;
  // +1 rocked over onto its right foot (+x), −1 its left.
  const sway = Math.sin(2 * Math.PI * t);
  const rock = GROOVE.rock * sway;
  // The beat's drop: down (+y) onto the legs, or the landing of a hop.
  const drop = (lag: number) =>
    rig.legs
      ? GROOVE.dip * s * onBeat(beatPhase(frameIdx, lag))
      : -GROOVE.hop * s * danceHopLift(frameIdx - lag * DANCE_BEAT);
  const bodyDrop = drop(0);
  // With legs the head nods on the body after the dip, and the ears flop
  // after that. Without, the head is what lands, so it can't nod into the
  // ground: the ears just trail the hop.
  const nod = rig.legs
    ? bodyDrop + GROOVE.nod * s * onBeat(beatPhase(frameIdx, GROOVE.nodLag))
    : bodyDrop;
  const flop = rig.legs
    ? nod + GROOVE.flop * s * onBeat(beatPhase(frameIdx, GROOVE.flopLag))
    : drop(GROOVE.flopLag);
  // Everything above the feet rocks about the point between them (the
  // bottom, without legs), then drops by `dy`.
  const pivot: V3 = [0, rig.floor, 0];
  const ride = (p: V3, dy: number): V3 =>
    add(turnAbout(p, pivot, rock), [0, dy, 0]);
  const armLift = GROOVE.armLift * onBeat(beatPhase(frameIdx, GROOVE.armLag));
  const armSwing =
    GROOVE.armSwing * Math.sin((Math.PI * frameIdx) / DANCE_BEAT);

  const deltas = spheres.map((sp): V3 => {
    const c = sp.center;
    if (isSceneFixed(sp.part)) return [0, 0, 0];
    if (isLeg(sp.part)) {
      // The foot it has rocked off taps up between beats; the other is
      // planted.
      const off = Math.max(0, -LIMB_SIDE[sp.part] * sway);
      const tap =
        GROOVE.tap * s * off * off * (1 - onBeat(beatPhase(frameIdx)));
      return [0, -tap, 0];
    }
    const shoulder = rig.shoulders[sp.part];
    if (shoulder) {
      // Turned about the shoulder, then carried along with its parent.
      const side = LIMB_SIDE[sp.part];
      const arm = turnAbout(c, shoulder, -side * armLift, 0, armSwing);
      return sub(ride(arm, rig.body ? bodyDrop : nod), c);
    }
    let dy = bodyDrop;
    if (sp.part === "head" || sp.part === "eye" || sp.part === "pupil") {
      dy = nod;
    } else if (sp.part === "ear") dy = flop;
    else if (sp.part === "spike") dy = spikeOnBody(sp, rig) ? bodyDrop : flop;
    return sub(ride(c, dy), c);
  });
  if (rig.legs) return deltas;
  // Rocked about the point it stands on, a round bottom would dip through
  // the ground (it rocks, rather than rolls): lift it back out.
  let lowest = Number.NEGATIVE_INFINITY;
  spheres.forEach((sp, i) => {
    if (isSceneFixed(sp.part)) return;
    lowest = Math.max(lowest, sp.center[1] + deltas[i][1] + sp.radius);
  });
  const lift = Math.min(0, rig.floor - lowest);
  return deltas.map((d, i) =>
    isSceneFixed(spheres[i].part) ? d : [d[0], d[1] + lift, d[2]],
  );
}

/** Returns a copy of the sphere list in its dance pose at `frameIdx`: the
 * herzie's groove, the boombox's bounce, and the spirit's float and hops. */
function applyDanceOffsets(
  spheres: Sphere[],
  frameIdx: number,
  hops: readonly SpiritHop[] = [],
): Sphere[] {
  const t = frameIdx / DANCE_FRAMES;
  const yOff = (amp: number, cycles: number, phase: number) =>
    Math.sin(2 * Math.PI * t * cycles + phase) * amp;
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
  const groove = danceDeltas(spheres, frameIdx);

  return spheres.map((s, i) => {
    if (s.part === "spirit") return moveSpirit(s);
    if (s.part === "pet")
      return { ...s, center: add(s.center, [0, petOff, 0]) };
    if (s.part === "ground") {
      return { ...s, center: add(s.center, [0, groundOff, 0]) };
    }
    return { ...s, center: add(s.center, groove[i]) };
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

/** How far out an arm's centre sits past the surface it hangs off, in arm
 * radii: the rest of the arm is sunk into it. */
const ARM_SINK = 0.4;
/** How far below horizontal the arms hang off the shoulder (radians): off
 * the head at stage 2, and higher on the body from stage 3. */
const ARM_DROOP = (15 * Math.PI) / 180;
const BODY_ARM_DROOP = (5 * Math.PI) / 180;

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

  // The body comes before the arms: they hang off it at stage 3 (off the
  // head at stage 2, before there is one).
  const bodyR = 0.5 * s;
  const bodyY = 0.18 * s;
  if (stage >= 3) {
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
  }

  if (stage >= 2) {
    // One sphere an arm, sunk a little into whatever it hangs off and angled
    // down from it, so it reads as joined at the shoulder.
    const armR = 0.17 * s;
    const [parentY, parentR] = stage >= 3 ? [bodyY, bodyR] : [headY, headR];
    const reach = parentR + ARM_SINK * armR;
    const droop = stage >= 3 ? BODY_ARM_DROOP : ARM_DROOP;
    for (const [side, part] of [
      [-1, "arm-l"],
      [1, "arm-r"],
    ] as const) {
      spheres.push({
        center: [
          side * reach * Math.cos(droop),
          parentY + reach * Math.sin(droop),
          0,
        ],
        radius: armR,
        zone: "primary",
        part,
      });
    }
  }

  if (stage >= 3) {
    // One sphere a leg, tucked under the body. Its bottom is where the old
    // hip-and-foot pair's was, so the herzie stands exactly as tall.
    const legR = 0.2 * s;
    const sole =
      bodyY + bodyR * 0.75 + HERZIE_BODY.legLength * 0.4 * s + 0.15 * s;
    for (const [side, part] of [
      [-1, "leg-l"],
      [1, "leg-r"],
    ] as const) {
      spheres.push({
        center: [side * 0.3 * s, sole - legR, 0],
        radius: legR,
        zone: "accent",
        part,
      });
    }
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

const HEADPHONE_SHELL = "#666666";
const HEADPHONE_CUSHION = "#2A2A2A";

function buildHeadphoneSpheres(spheres: Sphere[]): Sphere[] {
  const head = getHeadBounds(spheres);
  if (!head) return [];

  const [hx, hy, hz] = head.center;
  const hr = head.radius;
  const result: Sphere[] = [];
  const part = (
    center: V3,
    radius: number,
    color: string,
    shape?: Shape,
  ): Sphere => ({
    center,
    radius,
    zone: "wearable",
    part: "head",
    color,
    shape,
  });

  for (const side of [-1, 1]) {
    // Ear cup: a flat-faced disc on its side, its face out from the head.
    result.push(
      part([hx + side * hr * 1.02, hy, hz], hr * 0.3, HEADPHONE_SHELL, {
        kind: "cylinder",
        axis: [hr * 0.12, 0, 0],
        dome: hr * 0.09,
      }),
    );
    // Cushion: a darker, slimmer pad between the cup and the head.
    result.push(
      part([hx + side * hr * 0.86, hy, hz], hr * 0.27, HEADPHONE_CUSHION, {
        kind: "cylinder",
        axis: [hr * 0.06, 0, 0],
      }),
    );
  }

  // Band: one smooth tube arcing over the head from cup to cup, as capsules
  // chained end to end (each shares its ends with its neighbours). It must
  // stay at least ~1.5 cells thick on the default grid, or it breaks into
  // dots as the herzie turns.
  const bandR = hr * 0.11;
  const bandSteps = 12;
  const arcPoint = (i: number): V3 => {
    const angle = Math.PI * (i / bandSteps); // 0 = right cup, π = left
    return [
      hx + Math.cos(angle) * hr * 1.04,
      hy - Math.sin(angle) * hr * 1.12,
      hz,
    ];
  };
  for (let i = 0; i < bandSteps; i++) {
    const a = arcPoint(i);
    const b = arcPoint(i + 1);
    result.push(
      part(
        [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
        bandR,
        HEADPHONE_SHELL,
        {
          kind: "capsule",
          axis: [(b[0] - a[0]) / 2, (b[1] - a[1]) / 2, (b[2] - a[2]) / 2],
        },
      ),
    );
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
    return {
      ...s,
      center: [rx + pivot[0], y, rz + pivot[1]] as V3,
      shape: s.shape && { ...s.shape, axis: dangledAxis(s, state) },
    };
  });
}

/** A shaped part's axis, turned with its swing (as applyDangle turns it):
 * for a renderer that moves only centres, to turn the part itself. */
export function dangledAxis(s: Sphere, state: DangleState | undefined): V3 {
  const axis = s.shape?.axis ?? [0, 1, 0];
  if (!s.dangle || !state || state.swing === 0) return axis;
  return rotY(axis, state.swing * s.dangle.weight);
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
  offsetX: 0.48,
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

/** Flat cap (a sixpence): a puffy, domed tweed crown pulled down snug and
 * tipped forward, a short stiff peak poking out over the eyes, and a button
 * on top. Low on purpose, like the witch hat's squat crown: a grown
 * herzie's head sits near the top of the frame. No catalog item has it yet —
 * Boboku wears it (npc-looks.ts). */
function buildSixpenceSpheres(spheres: Sphere[]): Sphere[] {
  const head = getHeadBounds(spheres);
  if (!head) return [];
  const [hx, hy, hz] = head.center;
  const hr = head.radius;
  const tweed = "#6F5D4B";
  const peakTweed = "#5B4B3C";
  const result: Sphere[] = [];
  const push = (center: V3, radius: number, color: string, shape?: Shape) =>
    result.push({
      center,
      radius,
      zone: "wearable",
      part: "head",
      color,
      shape,
    });
  // Creature space is y down: up is −y; the face is toward −z.
  const tilt = 0.22;
  const crownHalf = hr * 0.1;
  const crownY = hy - hr * 0.8;
  // A thin, wide disc pulled down over the top of the head, puffed up by
  // its dome and tipped forward: the axis leans toward the face, so the
  // crown slopes down to the peak.
  push([hx, crownY, hz - hr * 0.08], hr * 0.95, tweed, {
    kind: "cylinder",
    axis: [0, -crownHalf, -crownHalf * tilt],
    dome: hr * 0.26,
  });
  // The peak: a thin disc tucked under the crown's front edge, so a
  // half-moon of it pokes out over the eyes, angled down a touch more.
  const peakHalf = hr * 0.025;
  push([hx, crownY + hr * 0.2, hz - hr * 0.82], hr * 0.5, peakTweed, {
    kind: "cylinder",
    axis: [0, -peakHalf, -peakHalf * 0.6],
  });
  // The button on top of the dome.
  push(
    [hx, crownY - crownHalf - hr * 0.29, hz - hr * 0.02],
    hr * 0.07,
    peakTweed,
  );
  return result;
}

/** A guard's helm: a steel cap pulled down over the head, a rim round its
 * base, a nose guard down the front and a stiff red crest running front to
 * back over the top. Low, like the sixpence. No catalog item has it — the
 * Tower Guard wears it (npc-looks.ts). */
function buildGuardHelmSpheres(spheres: Sphere[]): Sphere[] {
  const head = getHeadBounds(spheres);
  if (!head) return [];
  const [hx, hy, hz] = head.center;
  const hr = head.radius;
  const steel = "#B8C0CA";
  const rimSteel = "#8A94A0";
  const crest = "#C0392B";
  const result: Sphere[] = [];
  const push = (center: V3, radius: number, color: string, shape?: Shape) =>
    result.push({
      center,
      radius,
      zone: "wearable",
      part: "head",
      color,
      shape,
    });
  // Creature space is y down: up is −y; the face is toward −z.
  const capY = hy - hr * 0.62;
  const capHalf = hr * 0.16;
  // The cap: a squat cylinder domed on top, snug over the crown.
  push([hx, capY, hz], hr * 0.98, steel, {
    kind: "cylinder",
    axis: [0, -capHalf, 0],
    dome: hr * 0.34,
  });
  // The rim: a thin, slightly wider disc at the cap's base.
  const rimHalf = hr * 0.03;
  push([hx, capY + capHalf, hz], hr * 1.04, rimSteel, {
    kind: "cylinder",
    axis: [0, -rimHalf, 0],
  });
  // The nose guard: a short bar down the front, between the eyes.
  for (let i = 0; i < 3; i++) {
    push(
      [hx, capY + capHalf + hr * (0.08 + i * 0.1), hz - hr * 0.98],
      hr * 0.07,
      rimSteel,
    );
  }
  // The crest: a row of red tufts from front to back over the dome, tallest
  // in the middle.
  const top = capY - capHalf - hr * 0.3;
  for (let i = -3; i <= 3; i++) {
    const t = i / 3;
    push(
      [hx, top - hr * 0.16 * (1 - t * t), hz + t * hr * 0.62],
      hr * (0.15 - 0.03 * Math.abs(t)),
      crest,
    );
  }
  return result;
}

/** Pointed witch hat: a flat brim, an orange band, and a cone whose top
 * bends over in a few tapering segments to a point. The bent tip carries
 * dangle weights, so it swings round the hat's axis when the herzie is spun
 * (see applyDangle). */
function buildWitchHatSpheres(spheres: Sphere[]): Sphere[] {
  const head = getHeadBounds(spheres);
  if (!head) return [];
  const [hx, hy, hz] = head.center;
  const hr = head.radius;
  const felt = "#6B4A94";
  const result: Sphere[] = [];
  const push = (
    center: V3,
    radius: number,
    color: string,
    shape?: Shape,
    dangle?: Dangle,
  ) =>
    result.push({
      center,
      radius,
      zone: "wearable",
      part: "head",
      color,
      shape,
      dangle,
    });
  // Creature space is y down: up is −y.
  const brimY = hy - hr * 0.62;
  const brimHalf = hr * 0.04;
  const crownBase = brimY - brimHalf;
  // Squat on purpose: a grown herzie's head sits close to the top of the
  // frame, and a classic tall hat would be cut off.
  const crownHalf = hr * 0.28;
  const crownTop = hr * 0.32;

  // The crown is solid now, not a pile of balls, so the head mustn't poke
  // out through its sides (seen from above): wide enough at its base that,
  // tapering, it still clears the head all the way up.
  const heads = spheres.filter(
    (s) => s.part === "head" && s.zone !== "wearable",
  );
  const headWidth = (y: number) => {
    let w = 0;
    for (const s of heads) {
      const dy = y - s.center[1];
      if (Math.abs(dy) >= s.radius) continue;
      const off = Math.hypot(s.center[0] - hx, s.center[2] - hz);
      w = Math.max(w, off + Math.sqrt(s.radius ** 2 - dy * dy));
    }
    return w;
  };
  let crownR = hr * 0.56;
  for (let i = 0; i < 8; i++) {
    const t = i / 8; // up the crown, 0 at its base
    const clear = headWidth(crownBase - t * 2 * crownHalf) + hr * 0.04;
    crownR = Math.max(crownR, (clear - crownTop * t) / (1 - t));
  }

  // Brim: a wide disc resting on the head, the band just above it.
  push([hx, brimY, hz], Math.max(hr, crownR + hr * 0.4), felt, {
    kind: "cylinder",
    axis: [0, brimHalf, 0],
  });
  const bandHalf = hr * 0.09;
  push([hx, crownBase - bandHalf, hz], crownR + hr * 0.04, "#F27B13", {
    kind: "cylinder",
    axis: [0, bandHalf, 0],
  });
  push([hx, crownBase - crownHalf, hz], crownR, felt, {
    kind: "cone",
    axis: [0, -crownHalf, 0],
    tipRadius: crownTop,
  });

  // Tip: segments bending further over to one side each, down to a point.
  // A ball at each bend fills the wedge the turn opens between them.
  const segments = [
    { tilt: 30, length: 0.22, radius: 0.22 },
    { tilt: 62, length: 0.2, radius: 0.13 },
    { tilt: 100, length: 0.2, radius: 0 },
  ];
  let at: V3 = [hx, crownBase - 2 * crownHalf, hz];
  let r = crownTop;
  const along = segments.reduce((sum, seg) => sum + seg.length, 0);
  let done = 0;
  const swing = (d: number): Dangle | undefined =>
    d > 0 ? { weight: d / along, hang: 0, pivot: [hx, hz] } : undefined;
  for (const seg of segments) {
    push(at, r, felt, undefined, swing(done));
    const a = (seg.tilt * Math.PI) / 180;
    const half: V3 = [
      (Math.sin(a) * seg.length * hr) / 2,
      (-Math.cos(a) * seg.length * hr) / 2,
      0,
    ];
    const center: V3 = [at[0] + half[0], at[1] + half[1], at[2]];
    push(
      center,
      r,
      felt,
      { kind: "cone", axis: half, tipRadius: seg.radius * hr },
      swing(done + seg.length / 2),
    );
    at = [center[0] + half[0], center[1] + half[1], at[2]];
    r = seg.radius * hr;
    done += seg.length;
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

// --- Held class equipment ---
// Class gear (classes.ts) is slung on the herzie's back, and drawn into its
// hands to fight. A herzie's hand is the far end of its one-sphere arm; the
// props are tagged with their own parts, "held-l" and "held-r", not the
// arm's — more than one "arm-l" sphere would read as the boss's chained arms
// (buildRig), and the cast poses the arm by placing its one sphere outright.
//
// Each prop is built in the hand (posed against the arm at rest), then slung:
// moved rigidly onto the back, which is where the model has it at rest — so
// every still view shows it there. Its HeldSocket remembers the way back to
// the hand. creaturePoseOffsets' drawPhase carries it between the two
// (heldPoses): on the back it rides the body; drawn, it turns with its arm
// about the shoulder; in between, the arm reaches up over its shoulder for it
// (drawArmDeltas) and it swings from the one to the other.
//
// The main hand is the casting arm, CAST_ARM, so the wave leaves from the
// stick, the disc or the lute; the off hand is the other.

/** Which arm each held part rides. */
export const HELD_ARM: Readonly<Record<string, string>> = {
  "held-l": "arm-l",
  "held-r": "arm-r",
};
/** The main hand's part: CAST_ARM's ("arm-l"). Spelled out, not derived,
 * since CAST_ARM is declared further down; a test pins the two together. */
export const MAIN_HELD = "held-l";
export const OFF_HELD = "held-r";

/** A held prop's way from the back to the hand. One per prop, shared by its
 * spheres, whose centers and axes are where it's slung. */
export interface HeldSocket {
  /** The palm, as it holds the prop with the arm at rest. */
  grip: V3;
  /** That point of it, slung on the back. */
  back: V3;
  /** Where on the back the hand reaches to take hold of it: the handle. */
  handle: V3;
  /** Turns the prop from how it lies on the back to how it's held. */
  toHand: Quat;
  /** Its length, from the hand out (a stick's tip), as it lies on the back:
   * what a swing lines up with the arm (see HeldSwing). */
  long: V3;
  /** It hangs on a thread, the `index`th weight of `rig`, and swings (see
   * thread-physics.ts). */
  thread?: { rig: ThreadRig; index: number };
}

/** A rotation, as a unit quaternion [x, y, z, w]. */
type Quat = [number, number, number, number];

function cross(a: V3, b: V3): V3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
const quatConj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
function quatNorm(q: Quat): Quat {
  const n = Math.max(1e-12, Math.hypot(...q));
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
/** `v` turned by `q`. */
function quatRotate(q: Quat, v: V3): V3 {
  const u: V3 = [q[0], q[1], q[2]];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[3])), cross(u, t));
}
/** The shortest turn taking direction `from` to direction `to`. */
function quatFromTo(from: V3, to: V3): Quat {
  const a = norm(from);
  const b = norm(to);
  const d = dot(a, b);
  if (d < -1 + 1e-9) {
    const axis = norm(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    return [...axis, 0];
  }
  return quatNorm([...cross(a, b), 1 + d]);
}
function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const to: Quat = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
  d = Math.abs(d);
  if (d > 0.9995) {
    return quatNorm([0, 1, 2, 3].map((k) => a[k] + (to[k] - a[k]) * t) as Quat);
  }
  const th = Math.acos(d);
  const wa = Math.sin((1 - t) * th) / Math.sin(th);
  const wb = Math.sin(t * th) / Math.sin(th);
  return [0, 1, 2, 3].map((k) => a[k] * wa + to[k] * wb) as Quat;
}
/** The turn taking x, y and z to a frame whose x is `long` and whose y is
 * `face` (made square to it). */
function frameQuat(long: V3, face: V3): Quat {
  const x = norm(long);
  const y = norm(sub(face, scale(x, dot(face, x))));
  const z = cross(x, y);
  // Rows of the matrix whose columns are x, y, z.
  const [m00, m01, m02] = [x[0], y[0], z[0]];
  const [m10, m11, m12] = [x[1], y[1], z[1]];
  const [m20, m21, m22] = [x[2], y[2], z[2]];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}

interface Hand {
  /** Where the palm is. */
  at: V3;
  /** Unit vector down the arm, shoulder to hand. */
  dir: V3;
  /** −1 the creature's left (−x), 1 its right. */
  side: -1 | 1;
  /** Where the arm joins the torso. */
  shoulder: V3;
  /** The arm's radius: props are sized by it, so they fit any stage. */
  r: number;
  /** What the arm hangs off (the body, or the head before it): the prop is
   * slung on its back. */
  torso: { center: V3; radius: number };
}

function handOf(spheres: Sphere[], arm: string): Hand | null {
  const sp = spheres.find((s) => s.part === arm);
  if (!sp) return null;
  const rig = buildRig(spheres);
  const shoulder = rig.shoulders[arm];
  const parent = rig.body ?? rig.head;
  if (!shoulder || !parent) return null;
  const v = sub(sp.center, shoulder);
  const len = Math.max(1e-9, Math.hypot(...v));
  const dir = scale(v, 1 / len);
  return {
    at: add(sp.center, scale(dir, sp.radius * 0.7)),
    dir,
    side: LIMB_SIDE[arm] ?? 1,
    shoulder,
    r: sp.radius,
    torso: { center: parent.center, radius: parent.radius },
  };
}

function norm(v: V3): V3 {
  return scale(v, 1 / Math.max(1e-9, Math.hypot(...v)));
}

/** Where the hand takes hold of a prop on the back: behind the top of its
 * shoulder, `reach` palm lengths from it — as far as its stubby arm goes —
 * and at least `lift` clear of the torso; and which way is out from there. */
function behindShoulder(hand: Hand, lift: number, reach = 1.45) {
  const { center, radius } = hand.torso;
  const palm = Math.hypot(...sub(hand.at, hand.shoulder));
  const at = add(
    hand.shoulder,
    scale(norm([-hand.side * 0.15, -0.6, 0.8]), palm * reach),
  );
  const out = norm(sub(at, center));
  const clear = radius + lift;
  return {
    at:
      Math.hypot(...sub(at, center)) < clear
        ? add(center, scale(out, clear))
        : at,
    out,
  };
}

/** A point on the back: `x` across (+ the creature's right) and `y` down
 * from the torso's middle, in torso radii, `lift` out from its surface. */
function onBack(hand: Hand, x: number, y: number, lift: number): V3 {
  const { center, radius } = hand.torso;
  const out: V3 = [x, y, Math.sqrt(Math.max(0, 1 - x * x - y * y))];
  return add(center, scale(out, radius + lift));
}

/** Up (−y), along a disc whose face looks along `face`. */
function upAcross(face: V3): V3 {
  return norm(sub([0, -1, 0], scale(face, -face[1])));
}

/** How a prop lies: a point of it, its length's direction, and the way its
 * face looks. */
interface Lie {
  at: V3;
  long: V3;
  face: V3;
}

/** `inHand`, built in the hand as it `held` it, slung on the back as it
 * lies there (`back`, the same point and directions of it). That point is
 * its handle, where the hand takes hold of it on the back — unless `handle`
 * says where that is instead (on the back). */
function slung(
  hand: Hand,
  inHand: Sphere[],
  held: Lie,
  back: Lie,
  handle: V3 = back.at,
): Sphere[] {
  const toHand = quatMul(
    frameQuat(held.long, held.face),
    quatConj(frameQuat(back.long, back.face)),
  );
  const toBack = quatConj(toHand);
  const place = (p: V3) => add(back.at, quatRotate(toBack, sub(p, held.at)));
  const socket: HeldSocket = {
    grip: hand.at,
    back: place(hand.at),
    handle,
    toHand,
    long: quatRotate(toBack, held.long),
  };
  return inHand.map((s) => ({
    ...s,
    center: place(s.center),
    shape: s.shape && { ...s.shape, axis: quatRotate(toBack, s.shape.axis) },
    held: socket,
  }));
}

type HeldBuilder = (spheres: Sphere[], part: string, hand: Hand) => Sphere[];

const held = (
  part: string,
  center: V3,
  radius: number,
  color: string,
  shape?: Shape,
  finish?: Sphere["finish"],
): Sphere => ({
  center,
  radius,
  zone: "wearable",
  part,
  color,
  shape,
  ...(finish && { finish }),
});

/** Which way an arm points at the ready, its gear drawn, from its shoulder
 * (see drawHand): out to its side, low and a little forward. */
function readyDir(side: number): V3 {
  return norm([side * 0.8, 0.3, -0.55]);
}

/** A direction in the hand as it's built (the arm at rest), for one that
 * should point `v` once the arm's at the ready: drawing turns the arm out
 * to it, and whatever it holds with it. */
function atTheReady(hand: Hand, v: V3): V3 {
  return quatRotate(quatConj(quatFromTo(hand.dir, readyDir(hand.side))), v);
}

/** Where a Percussionist's gear lies on its back, stacked like the discs:
 * the cymbal over the middle of the back, bell out, and the stick under
 * it, its grip peeping up past the cymbal's top rim. */
function percussionBack(hand: Hand) {
  const { r } = hand;
  // How far each rides off the back: the stick against it, the cymbal over
  // the stick.
  const cymbalLift = r * 0.45;
  const center = onBack(hand, 0, 0.05, cymbalLift);
  const out = norm(sub(center, hand.torso.center));
  const up = upAcross(out);
  return {
    cymbal: { center, out, up },
    // The grip above the rim; the stick leans a little toward its own
    // shoulder, so it reads as one thing behind the other.
    stickGrip: add(
      add(center, add(scale(up, r * 2.2), [hand.side * r * 0.9, 0, 0])),
      scale(out, -(cymbalLift - r * 0.2)),
    ),
    stickDown: norm(add(scale(up, -1), [-hand.side * 0.35, 0, 0])),
  };
}

/** Worn Stick: held like a wand, easy — out of the fist pointing forward
 * and a little down, once drawn. On the back, under the cymbal, grip up
 * (see percussionBack). */
const buildWornStick: HeldBuilder = (_s, part, hand) => {
  const { at, r } = hand;
  const half = r * 1.3;
  const axis = atTheReady(hand, norm([-hand.side * 0.08, 0.32, -1]));
  // The butt just behind the fist, the rest of it out ahead.
  const mid = add(at, scale(axis, half * 0.85));
  const back = percussionBack(hand);
  return slung(
    hand,
    [
      // Ebony, near black: dark against the cymbal's shine, and well below
      // the lute's brown neck.
      held(part, mid, r * 0.14, "#2a2422", {
        kind: "capsule",
        axis: scale(axis, half),
      }),
      held(part, add(mid, scale(axis, half)), r * 0.2, "#3b3330"),
    ],
    { at, long: axis, face: cross(axis, atTheReady(hand, [0, 0, 1])) },
    {
      at: back.stickGrip,
      long: back.stickDown,
      face: cross(back.stickDown, back.cymbal.out),
    },
  );
};

/** Old Cymbal: held at its side, edge to the front, the inside of it along
 * the herzie's flank and the bell out, once drawn. On the back, over the
 * stick, bell out (see percussionBack). */
const buildOldCymbal: HeldBuilder = (_s, part, hand) => {
  const { at, side, r } = hand;
  const face = atTheReady(hand, [side, 0, 0]);
  const forward = atTheReady(hand, [0, 0, -1]);
  const up = upAcross(face);
  // Just outside the hand, so the hand's behind it, and a little forward.
  const center = add(
    at,
    add(
      scale(face, r * 0.35),
      add(scale(forward, r * 0.3), scale(up, r * 0.2)),
    ),
  );
  const back = percussionBack(hand).cymbal;
  return slung(
    hand,
    [
      held(
        part,
        center,
        r * 1.5,
        "#d4b04c",
        {
          kind: "cylinder",
          axis: scale(face, r * 0.05),
          dome: r * 0.12,
        },
        "metal",
      ),
      // The bell, and verdigris at the rim: the patina stays dull.
      held(
        part,
        add(center, scale(face, r * 0.1)),
        r * 0.35,
        "#b8923a",
        {
          kind: "cylinder",
          axis: scale(face, r * 0.08),
        },
        "metal",
      ),
      held(
        part,
        add(center, add(scale(forward, r * 1.15), scale(up, r * 0.6))),
        r * 0.22,
        "#6fa38a",
        {
          kind: "cylinder",
          axis: scale(face, r * 0.06),
        },
      ),
    ],
    // By the top of its rim.
    { at: add(center, scale(up, r * 1.3)), long: up, face },
    {
      at: add(back.center, scale(back.up, r * 1.3)),
      long: back.up,
      face: back.out,
    },
    // Taken by the rim nearest its shoulder, as a disc is.
    rimToward(back.center, back.out, hand.shoulder, r * 1.4),
  );
};

/** The point on a disc's rim (`radius` from `center`, its face looking
 * `out`) nearest `toward`. */
function rimToward(center: V3, out: V3, toward: V3, radius: number): V3 {
  const to = sub(toward, center);
  return add(center, scale(norm(sub(to, scale(out, dot(to, out)))), radius));
}

/** One Compact Disc, upright in the palm, its face to the side; on the back
 * at `onIt`, lying flat against it. The hand takes it by the rim nearest
 * its shoulder. */
/** How far a held disc's middle is from its hand's, along the disc's face,
 * in arm radii: past the hand's surface by the hub's half-thickness. */
const DISC_STANDOFF = 1.08;

function discIn(
  part: string,
  hand: Hand,
  onIt: V3,
  thread?: HeldSocket["thread"],
): Sphere[] {
  const { at, side, r } = hand;
  // Once drawn, its face out to the side of the hand and turned some 25°
  // toward the front: the disc's plane runs mostly front to back. Drawing
  // turns the arm out to the ready (see drawHand), and the disc with it,
  // about 35° — so it's turned back by as much here.
  const face: V3 = norm([side * 0.7, -0.1, 0.1]);
  // Flat against the outside of the hand, palm on its face: clear of the
  // hand's sphere (a disc no bigger than the hand, through it, shows the
  // skin either side), and a little ahead of it and down.
  const ball = sub(at, scale(hand.dir, r * 0.7));
  const drop: V3 = [0, r * 0.15, -r * 0.5];
  const center = add(
    add(ball, scale(face, r * DISC_STANDOFF)),
    sub(drop, scale(face, dot(drop, face))),
  );
  const out = norm(sub(onIt, hand.torso.center));
  // The rim toward its shoulder, along the disc.
  const toShoulder = sub(hand.shoulder, onIt);
  const rim = add(
    onIt,
    scale(norm(sub(toShoulder, scale(out, dot(toShoulder, out)))), r * 0.9),
  );
  const disc = slung(
    hand,
    [
      held(part, center, r * 0.95, "#d9d9e8", {
        kind: "cylinder",
        axis: scale(face, r * 0.04),
      }),
      held(part, center, r * 0.22, "#3a3a4a", {
        kind: "cylinder",
        axis: scale(face, r * 0.06),
      }),
    ],
    { at: center, long: [0, -1, 0], face },
    { at: onIt, long: [0, -1, 0], face: out },
    rim,
  );
  const socket = disc[0]?.held;
  if (socket && thread) socket.thread = thread;
  return disc;
}

/** How far each disc rides off the back, in arm radii: the upper one over
 * the lower. */
const DISC_LIFT: Record<string, number> = {
  [MAIN_HELD]: 0.18,
  [OFF_HELD]: 0.1,
};

/**
 * Compact Discs: one item, a disc in each hand. On the back they hang down
 * the spine on invisible threads — the main hand's tied up between the
 * shoulders, the other tied to it — and swing as the herzie moves (see
 * thread-physics.ts). Built where they settle, so a still herzie shows them
 * as they'd really hang.
 */
const buildCompactDiscs: HeldBuilder = (spheres, part, hand) => {
  const otherPart = part === MAIN_HELD ? OFF_HELD : MAIN_HELD;
  const other = handOf(spheres, HELD_ARM[otherPart]);
  const hung = [
    { part, hand },
    ...(other ? [{ part: otherPart, hand: other }] : []),
  ].sort((a, b) => (a.part === MAIN_HELD ? -1 : b.part === MAIN_HELD ? 1 : 0));
  const top = hung[0].hand;
  const { center, radius } = top.torso;
  const lift = (h: (typeof hung)[number]) => h.hand.r * DISC_LIFT[h.part];
  // Where they'd hang: one above the other, down the spine.
  const guess = hung.map((h, i) =>
    onBack(h.hand, 0, i === 0 ? -0.32 : 0, lift(h)),
  );
  const knot = onBack(top, 0, -0.62, lift(hung[0]));
  const rig: ThreadRig = {
    knot,
    lengths: guess.map((g, i) =>
      Math.hypot(...sub(g, i === 0 ? knot : guess[i - 1])),
    ),
    rest: guess,
    center,
    clear: hung.map((h) => radius + lift(h)),
    parts: hung.map((h) => h.part),
  };
  rig.rest = settleThread(rig);
  return hung.flatMap((h, index) =>
    discIn(h.part, h.hand, rig.rest[index], { rig, index }),
  );
};

/** Lute: in the hand, its body at the palm and the neck pointing forward
 * and a little down — carried easy. On the back, slung across: the neck up
 * behind the casting shoulder, where the hand takes it, the body low across
 * the back. */
const buildLute: HeldBuilder = (_s, part, hand) => {
  const { at, side, r } = hand;
  // Its face looks outward, away from the herzie.
  const face: V3 = [side, 0, 0];
  const neckDir = norm([0, 0.35, -1]);
  const body = add(at, [side * r * 0.35, -r * 0.1, 0]);
  const neckHalf = r * 1.1;
  const neckMid = add(body, scale(neckDir, r * 0.8 + neckHalf));
  const handle = behindShoulder(hand, r * 0.2).at;
  return slung(
    hand,
    [
      held(part, body, r * 0.95, "#c98a4b", {
        kind: "cylinder",
        axis: scale(face, r * 0.22),
        dome: r * 0.25,
      }),
      // Sound hole.
      held(
        part,
        add(body, [side * r * 0.24, 0, -r * 0.15]),
        r * 0.24,
        "#2b1a0e",
        {
          kind: "cylinder",
          axis: scale(face, r * 0.03),
        },
      ),
      held(part, neckMid, r * 0.16, "#6b4226", {
        kind: "capsule",
        axis: scale(neckDir, neckHalf),
      }),
      // Pegbox, bent back.
      held(
        part,
        add(neckMid, scale(neckDir, neckHalf + r * 0.25)),
        r * 0.2,
        "#4a2c18",
        {
          kind: "capsule",
          axis: scale(norm([0, 0.9, -0.3]), r * 0.18),
        },
      ),
    ],
    // By the neck.
    { at: add(neckMid, scale(neckDir, neckHalf * 0.3)), long: neckDir, face },
    {
      at: handle,
      // From the middle of the back, where the body sits, clear of it.
      long: norm(sub(handle, onBack(hand, -side * 0.15, 0.2, r * 0.7))),
      face: [0, 0, 1],
    },
  );
};

const HELD_ITEM_BUILDERS: Record<string, HeldBuilder> = {
  "worn-stick": buildWornStick,
  "old-cymbal": buildOldCymbal,
  "compact-discs": buildCompactDiscs,
  lute: buildLute,
};

function buildHeldSpheres(spheres: Sphere[], equipped: Equipped): Sphere[] {
  const out: Sphere[] = [];
  for (const [slot, part] of [
    ["main_hand", MAIN_HELD],
    ["off_hand", OFF_HELD],
  ] as const) {
    const id = equipped[slot];
    const build = id && HELD_ITEM_BUILDERS[id];
    const hand = build ? handOf(spheres, HELD_ARM[part]) : null;
    if (build && hand) out.push(...build(spheres, part, hand));
  }
  return out;
}

/**
 * Drawing class gear off the back, as fractions of the draw (drawPhase
 * 0..1): the hand reaches up over its shoulder and back down to the prop's
 * handle, takes hold of it at GRAB — the prop hasn't moved till then — and
 * brings it round to the ready, overshooting a touch before it settles.
 * Putting it away plays the same path backward.
 */
export const DRAW = {
  /** The hand is at the handle: from here the prop goes with it. */
  grab: 0.4,
  /** The prop's settled in the hand the way it's held. */
  held: 0.8,
  /** The off hand draws this much later. */
  stagger: 0.1,
  /** How far up over its shoulder the reach bends (0: straight there). */
  over: 1.2,
  /** The furthest the arm stretches to reach a handle (arm lengths). Most
   * handles are behind the shoulder, in reach (see behindShoulder); the
   * discs, stacked down the spine, are past it — the hand gets as near as
   * it can and the disc's caught into it from there. */
  maxReach: 2,
  /** The overshoot into the ready (easeOutBack's). */
  overshoot: 1.6,
  /** At the ready, how much of the idle and walk swing the arm keeps. */
  sway: 0.5,
} as const;

const easeOutBack = (t: number) => {
  const c = DRAW.overshoot;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};

/** How far drawn `part` is at `drawPhase`: the off hand a little behind. */
function heldPhase(part: string, drawPhase: number): number {
  if (part !== OFF_HELD) return drawPhase;
  return Math.max(0, (drawPhase - DRAW.stagger) / (1 - DRAW.stagger));
}

/** The socket of each held part there is. */
function heldSockets(spheres: Sphere[]): Record<string, HeldSocket> {
  const out: Record<string, HeldSocket> = {};
  for (const s of spheres) if (s.held && !out[s.part]) out[s.part] = s.held;
  return out;
}

/** Where the arm is, `p` through drawing the prop in `socket`, from the
 * `shoulder` it hangs off (`rest`: shoulder to arm, at rest): a direction,
 * and how far along it in arm lengths — so the palm is that far along it in
 * palm lengths. */
function drawHand(
  p: number,
  socket: HeldSocket,
  shoulder: V3,
  rest: V3,
  side: number,
): { dir: V3; reach: number } {
  const toHandle = sub(socket.handle, shoulder);
  const palm = Math.max(1e-9, Math.hypot(...sub(socket.grip, shoulder)));
  const grab = norm(toHandle);
  const grabReach = Math.min(
    DRAW.maxReach,
    Math.max(0.6, Math.hypot(...toHandle) / palm),
  );
  // Out to its side, low and a little forward: the prop's at the ready.
  const ready = readyDir(side);
  if (p < DRAW.grab) {
    // Up over the shoulder on the way: reaching straight for the back would
    // go through it.
    const u = easeOut(p / DRAW.grab);
    const over = scale(norm([side * 0.35, -1, 0.35]), DRAW.over);
    const dir = norm(
      add(
        add(scale(norm(rest), (1 - u) ** 2), scale(over, 2 * u * (1 - u))),
        scale(grab, u * u),
      ),
    );
    return { dir, reach: 1 + (grabReach - 1) * u };
  }
  // Eased in as well as out: straight off the grab at full speed would
  // flick it round in a frame.
  const t = easeOutBack(ease(DRAW.grab, 1, p));
  return {
    dir: norm(add(scale(grab, 1 - t), scale(ready, t))),
    reach: grabReach + (1 - grabReach) * t,
  };
}

/** Where each arm with a prop to draw is, `drawPhase` through the draw, as
 * offsets from rest (`deltas`, by `weight`), and how much of its own swing
 * it `keeps`: none through the draw, some at the ready. */
function drawArmDeltas(
  spheres: Sphere[],
  drawPhase: number,
): { deltas: V3[]; weight: number[]; keeps: number[] } {
  const deltas = spheres.map((): V3 => [0, 0, 0]);
  const weight = spheres.map(() => 0);
  const keeps = spheres.map(() => 1);
  const sockets = heldSockets(spheres);
  if (drawPhase <= 0 || Object.keys(sockets).length === 0)
    return { deltas, weight, keeps };
  const rig = buildRig(spheres);
  for (const [part, socket] of Object.entries(sockets)) {
    const arm = HELD_ARM[part];
    const i = spheres.findIndex((s) => s.part === arm);
    const shoulder = rig.shoulders[arm];
    if (i < 0 || !shoulder) continue;
    const p = heldPhase(part, drawPhase);
    const rest = sub(spheres[i].center, shoulder);
    const length = Math.hypot(...rest);
    const { dir, reach } = drawHand(
      p,
      socket,
      shoulder,
      rest,
      LIMB_SIDE[arm] ?? 1,
    );
    deltas[i] = sub(
      add(shoulder, scale(dir, length * reach)),
      spheres[i].center,
    );
    weight[i] = ease(0, 0.12, p);
    keeps[i] = 1 - weight[i] * (1 - DRAW.sway * ease(DRAW.held, 1, p));
  }
  return { deltas, weight, keeps };
}

/** Where each arm points, from its shoulder: at rest, and with `offsets`
 * applied. */
function armDirections(
  spheres: Sphere[],
  offsets: readonly V3[],
): Record<string, { shoulder: V3; shoulderNow: V3; rest: V3; now: V3 }> {
  const out: Record<
    string,
    { shoulder: V3; shoulderNow: V3; rest: V3; now: V3 }
  > = {};
  const rig = buildRig(spheres);
  const parent = rig.body ?? rig.head;
  const parentAt = parent ? spheres.indexOf(parent) : -1;
  const parentOff: V3 = parentAt >= 0 ? offsets[parentAt] : [0, 0, 0];
  for (const [heldPart, arm] of Object.entries(HELD_ARM)) {
    const i = spheres.findIndex((s) => s.part === arm);
    const shoulder = rig.shoulders[arm];
    if (i < 0 || !shoulder) continue;
    const shoulderNow = add(shoulder, parentOff);
    out[heldPart] = {
      shoulder,
      shoulderNow,
      rest: sub(spheres[i].center, shoulder),
      now: sub(add(spheres[i].center, offsets[i]), shoulderNow),
    };
  }
  return out;
}

/** A held prop, posed: where a point of it at rest (slung on the back) is
 * now, and how a direction of it has turned. */
export interface HeldPose {
  place(p: V3): V3;
  turn(v: V3): V3;
}

/**
 * Each held part's pose, `drawPhase` of the way from the back to the hand,
 * with the body and arms where `offsets` put them. On the back it rides the
 * body. From the grab on it goes with the hand — turning with the arm about
 * the shoulder, out with its reach (a cast reaches out) — held first just as
 * it lay when the hand took it, then shifting round in the hand to how it's
 * held. It's rigid throughout: nothing of it stretches.
 */
export function heldPoses(
  spheres: Sphere[],
  offsets: readonly V3[],
  drawPhase: number,
  /** How far each held part hanging on a thread has swung (see
   * CreatureMotion's heldSway). */
  sway?: Readonly<Record<string, V3>>,
  /** A strike under way (see heldSwing): its stick lines up with its arm. */
  swing?: HeldSwing,
): Record<string, HeldPose> {
  const out: Record<string, HeldPose> = {};
  const sockets = heldSockets(spheres);
  if (Object.keys(sockets).length === 0) return out;
  const arms = armDirections(spheres, offsets);
  for (const [part, socket] of Object.entries(sockets)) {
    const arm = arms[part];
    if (!arm) continue;
    const p = heldPhase(part, drawPhase);
    if (p <= DRAW.grab) {
      const ride = sub(arm.shoulderNow, arm.shoulder);
      const swung = sway?.[part];
      if (!socket.thread || !swung) {
        out[part] = { place: (x) => add(x, ride), turn: (v) => v };
        continue;
      }
      // Swung on its thread — settling back as the hand reaches for it, so
      // the grab takes it from where it rests — and hanging from it: it
      // tilts as its thread does, like a pendulum's bob.
      const { rig, index } = socket.thread;
      const settle = 1 - ease(0, DRAW.grab, p);
      const d = scale(swung, settle);
      const rest = rig.rest[index];
      const tiedRest = index === 0 ? rig.knot : rig.rest[index - 1];
      const tiedSwung = index === 0 ? undefined : sway?.[rig.parts[index - 1]];
      const tiedNow = tiedSwung
        ? add(tiedRest, scale(tiedSwung, settle))
        : tiedRest;
      const turn = quatFromTo(sub(tiedRest, rest), sub(tiedNow, add(rest, d)));
      const at = add(add(rest, ride), d);
      out[part] = {
        place: (x) => add(at, quatRotate(turn, sub(x, rest))),
        turn: (v) => quatRotate(turn, v),
      };
      continue;
    }
    // The arm as the draw had it at the grab (taking the arm over, so it's
    // where the arm was): how the prop lay against the hand.
    const palm = Math.hypot(...sub(socket.grip, arm.shoulder));
    const at = drawHand(
      DRAW.grab,
      socket,
      arm.shoulder,
      arm.rest,
      LIMB_SIDE[HELD_ARM[part]] ?? 1,
    );
    const fromGrab = quatConj(quatFromTo(arm.rest, at.dir));
    const grabPalm = add(arm.shoulder, scale(at.dir, palm * at.reach));
    // In the hand's own terms: the handle, and the turn, from as it lay to
    // as it's held. (Both ends are fixed, so the turn never flips.)
    const s = ease(DRAW.grab, DRAW.held, p);
    const inHand = quatSlerp(fromGrab, socket.toHand, s);
    const handle = add(
      scale(quatRotate(fromGrab, sub(socket.handle, grabPalm)), 1 - s),
      scale(quatRotate(socket.toHand, sub(socket.handle, socket.back)), s),
    );
    // Where the hand is now.
    const stretch =
      Math.hypot(...arm.now) / Math.max(1e-9, Math.hypot(...arm.rest));
    const armTurn = quatFromTo(arm.rest, arm.now);
    const hand = add(
      arm.shoulderNow,
      quatRotate(armTurn, scale(sub(socket.grip, arm.shoulder), stretch)),
    );
    let turn = quatMul(armTurn, inHand);
    let handleAt = add(hand, quatRotate(armTurn, handle));
    // Swung, the wrist turns it out along the arm, a little raised, and
    // round across the body as the swing goes, about the palm: a stick
    // swept like a blade, not chopped at the ground.
    if (swing && swing.weight > 0 && HELD_ARM[part] === swing.arm) {
      // Round the vertical, toward the other side (y is down).
      const a = (LIMB_SIDE[swing.arm] ?? 1) * swing.wrist;
      const [ax, ay, az] = norm(arm.now);
      const along = add(
        [
          ax * Math.cos(a) + az * Math.sin(a),
          ay,
          -ax * Math.sin(a) + az * Math.cos(a),
        ],
        [0, -STRIKE.wrist, 0],
      );
      const wrist = quatSlerp(
        [0, 0, 0, 1],
        quatFromTo(quatRotate(turn, socket.long), along),
        swing.weight,
      );
      turn = quatMul(wrist, turn);
      handleAt = add(hand, quatRotate(wrist, sub(handleAt, hand)));
    }
    out[part] = {
      place: (x) => add(handleAt, quatRotate(turn, sub(x, socket.handle))),
      turn: (v) => quatRotate(turn, v),
    };
  }
  return out;
}

/** `offsets` with every held part posed (see heldPoses). */
function holdProps(
  spheres: Sphere[],
  offsets: V3[],
  drawPhase: number,
  sway?: Readonly<Record<string, V3>>,
  swing?: HeldSwing,
): V3[] {
  const poses = heldPoses(spheres, offsets, drawPhase, sway, swing);
  if (Object.keys(poses).length === 0) return offsets;
  return offsets.map((d, i): V3 => {
    const pose = poses[spheres[i].part];
    return pose ? sub(pose.place(spheres[i].center), spheres[i].center) : d;
  });
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
  if (equipped.head === "sixpence") {
    spheres.push(...buildSixpenceSpheres(spheres));
  }
  if (equipped.head === "guard-helm") {
    spheres.push(...buildGuardHelmSpheres(spheres));
  }
  const bodyBuilder = equipped.body && BODY_ITEM_BUILDERS[equipped.body];
  if (bodyBuilder) spheres.push(...bodyBuilder(spheres));

  for (const side of ["left", "right"] as const) {
    const itemId = equipped[groundSlot(side)];
    if (itemId === "boombox") {
      spheres.push(...buildBoomboxSpheres(spheres, cols, side, boomboxConfig));
    }
  }

  spheres.push(...buildHeldSpheres(spheres, equipped));

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
/** Colour-scheme key for Boboku's orange, the same arrangement again. */
export const BOBOKU_SCHEME_ID = "npc-boboku";
/** Colour-scheme key for Medea's pink-to-plum, the same arrangement again. */
export const MEDEA_SCHEME_ID = "npc-medea";
/** Colour-scheme key for the Tower Guard's slate, the same arrangement again. */
export const TOWER_GUARD_SCHEME_ID = "npc-tower-guard";

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
  [BOBOKU_SCHEME_ID]: BOBOKU_RAMP,
  [MEDEA_SCHEME_ID]: MEDEA_RAMP,
  [TOWER_GUARD_SCHEME_ID]: TOWER_GUARD_RAMP,
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
// plain dance loop except for the spirit during its hop(s). the host picks
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

/** Dance hop variants a host can choose between (indices 0..n-1). */
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

// --- The rig ---
// A herzie's arms and legs are one sphere each, hung off a parent: the body
// at stage 3, the head before it. Every pose moves a limb by turning it about
// its joint, a point inside both the limb and its parent, so no pose can pull
// it off. Everything above the legs moves with the body or the head.

/** Which side a limb is on: −1 the creature's left (−x), 1 its right. */
const LIMB_SIDE: Record<string, -1 | 1> = {
  "arm-l": -1,
  "arm-r": 1,
  "leg-l": -1,
  "leg-r": 1,
};

/** Which side of the herzie a limb is on: −1 (−x) or 1 (+x), in creature
 * space — and so in the world's, turned by its heading, as seen from
 * behind: +1 is its left. */
export function limbSide(part: string): -1 | 1 {
  return LIMB_SIDE[part] ?? 1;
}
const isArm = (part: string) => part === "arm-l" || part === "arm-r";
const isLeg = (part: string) => part === "leg-l" || part === "leg-r";

/** How deep a shoulder sits inside the arm's parent, in arm radii. */
const SHOULDER_DEPTH = 0.3;
/** How high in the body the hips are, as a fraction of its radius below its
 * centre (y down). */
const HIP_HEIGHT = 0.35;

interface Rig {
  head: Sphere | undefined;
  body: Sphere | undefined;
  /** Each arm part's joint. */
  shoulders: Record<string, V3>;
  /** Each leg part's joint. */
  hips: Record<string, V3>;
  legs: boolean;
  /** Its arms are chains of spheres (the boss's), not one each. */
  chained: boolean;
  /** Creature-space y of its lowest point at rest: the soles, with legs. */
  floor: number;
}

function buildRig(spheres: Sphere[]): Rig {
  const head = largestPart(spheres, "head");
  const body = largestPart(spheres, "body");
  const parent = body ?? head;
  const shoulders: Record<string, V3> = {};
  const hips: Record<string, V3> = {};
  let floor = Number.NEGATIVE_INFINITY;
  for (const sp of spheres) {
    if (isSceneFixed(sp.part)) continue;
    // Held props can hang below a legless herzie; it still stands on itself.
    if (sp.part in HELD_ARM) continue;
    floor = Math.max(floor, sp.center[1] + sp.radius);
    if (isArm(sp.part) && parent) {
      // The arm sphere nearest the parent carries the shoulder (the boss's
      // arms are a chain of them).
      const prev = shoulders[sp.part];
      const d = Math.hypot(...sub(sp.center, parent.center));
      if (prev && Math.hypot(...sub(prev, parent.center)) <= d) continue;
      const depth = parent.radius - SHOULDER_DEPTH * sp.radius;
      shoulders[sp.part] = add(
        parent.center,
        scale(sub(sp.center, parent.center), depth / Math.max(d, 1e-9)),
      );
    } else if (isLeg(sp.part) && !hips[sp.part]) {
      hips[sp.part] = [
        sp.center[0],
        body ? body.center[1] + HIP_HEIGHT * body.radius : sp.center[1],
        sp.center[2],
      ];
    }
  }
  return {
    head,
    body,
    shoulders,
    hips,
    legs: Object.keys(hips).length > 0,
    chained: spheres.filter((sp) => sp.part === "arm-l").length > 1,
    floor,
  };
}

function add(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale(a: V3, k: number): V3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

/**
 * `p` turned about `pivot`: by `roll` in the frontal plane (x-y; positive
 * tips the top toward +x), then `pitch` in the side plane (y-z; positive
 * swings what hangs below toward the back, +z), then `yaw` about the
 * vertical (positive swings +x toward the front, −z). Creature space: y down,
 * front −z.
 */
function turnAbout(p: V3, pivot: V3, roll: number, pitch = 0, yaw = 0): V3 {
  let [x, y, z] = sub(p, pivot);
  let c = Math.cos(roll);
  let s = Math.sin(roll);
  [x, y] = [x * c - y * s, x * s + y * c];
  c = Math.cos(pitch);
  s = Math.sin(pitch);
  [y, z] = [y * c - z * s, y * s + z * c];
  c = Math.cos(yaw);
  s = Math.sin(yaw);
  [x, z] = [x * c + z * s, -x * s + z * c];
  return add(pivot, [x, y, z]);
}

/** What a spike moves with: the body (one on its flank) or the head (the
 * crest). */
function spikeOnBody(sp: Sphere, rig: Rig): boolean {
  const gap = (o: Sphere | undefined) =>
    o
      ? Math.hypot(...sub(sp.center, o.center)) - o.radius
      : Number.POSITIVE_INFINITY;
  return gap(rig.body) < gap(rig.head);
}

// --- Idle animation offsets ---

/** Each sphere's idle offset for `frameIdx`, as a delta so a pose can blend
 * it with the walk cycle (see creaturePoseOffsets). With legs, the body and
 * head breathe above feet that stay put; without, the herzie sits still on
 * the ground and only its ears and arms stir. */
function idleDeltas(spheres: Sphere[], frameIdx: number): V3[] {
  const t = frameIdx / IDLE_FRAMES;
  function wave(part: { amp: number; cycles: number }, phase: number) {
    return Math.sin(2 * Math.PI * t * part.cycles + phase) * part.amp;
  }

  const rig = buildRig(spheres);
  // A herzie without a body sits on its head, so that stays put. (The
  // boss has a body, and no legs: it breathes as it always did.)
  const bodyOff = rig.body ? wave(IDLE.body, 0) : 0;
  const headOff = rig.body ? wave(IDLE.head, 0) : 0;
  const earOff = headOff + wave(IDLE.ear, Math.PI / 4);
  const spikeOff = wave(IDLE.spike, Math.PI / 3);
  const spiritOff = wave(IDLE.spirit, Math.PI / 5);
  // The arms ride their parent, and sway about the shoulder in turn.
  const armParentOff = rig.body ? bodyOff : headOff;

  if (rig.chained) {
    // The boss, as it always breathed: each part bobs on its own, its long
    // arms in turn.
    const limb = (side: number) => wave(IDLE.limb, side === 1 ? Math.PI : 0);
    return spheres.map((s): V3 => {
      if (s.part === "spirit" || s.part === "pet") return [0, spiritOff, 0];
      if (s.part === "body") return [0, bodyOff, 0];
      if (s.part === "head" || s.part === "eye" || s.part === "pupil") {
        return [0, headOff, 0];
      }
      if (s.part === "ear") return [0, earOff - headOff, 0];
      if (s.part === "spike") return [0, spikeOff, 0];
      const side = LIMB_SIDE[s.part];
      return [0, side ? limb(side) : 0, 0];
    });
  }

  return spheres.map((s): V3 => {
    if (s.part === "spirit" || s.part === "pet") return [0, spiritOff, 0];
    if (s.part === "body") return [0, bodyOff, 0];
    if (s.part === "head" || s.part === "eye" || s.part === "pupil") {
      return [0, headOff, 0];
    }
    if (s.part === "ear") return [0, earOff, 0];
    if (s.part === "spike") {
      return [0, (spikeOnBody(s, rig) ? bodyOff : headOff) + spikeOff, 0];
    }
    const shoulder = rig.shoulders[s.part];
    if (shoulder) {
      const side = LIMB_SIDE[s.part];
      const raise = wave(IDLE.arm, side === 1 ? Math.PI : 0);
      const turned = turnAbout(s.center, shoulder, -side * raise);
      return add(sub(turned, s.center), [0, armParentOff, 0]);
    }
    return [0, 0, 0];
  });
}

// Returns a copy of the sphere list with the idle offsets applied.
function applyIdleOffsets(spheres: Sphere[], frameIdx: number): Sphere[] {
  const d = idleDeltas(spheres, frameIdx);
  return spheres.map((s, i) => ({ ...s, center: add(s.center, d[i]) }));
}

// --- Walk animation offsets ---
// One walk cycle is two steps (left, then right), as a fraction 0..1. The
// host advances it by distance covered, not by time, so the feet never
// slide. Lengths are fractions of the herzie's body scale, so they fit a
// stage 1 head as well as a stage 3 body. Creature space: front is -z, up is
// -y.

const WALK = {
  /** Stage 3: how far each leg swings forward and back about its hip
   * (radians). The body drops as the legs spread, which the grounding in
   * creaturePoseOffsets takes care of. */
  legAngle: 0.72,
  /** Stage 3: how high a foot lifts on its forward swing. */
  footLift: 0.14,
  /** Arms swing about the shoulder against the leg on their side (radians). */
  armAngle: 0.7,
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
  const rig = buildRig(spheres);
  // Arms swing forward against the leg on their side: the left back while
  // the left leg goes forward.
  const swingArm = (sp: Sphere): V3 => {
    const shoulder = rig.shoulders[sp.part];
    if (!shoulder) return [0, 0, 0];
    return sub(
      turnAbout(sp.center, shoulder, 0, 0, sin * WALK.armAngle),
      sp.center,
    );
  };

  if (rig.legs && stage >= 3) {
    return spheres.map((sp): V3 => {
      if (isSceneFixed(sp.part)) return [0, 0, 0];
      const hip = rig.hips[sp.part];
      if (hip) {
        // Right runs half a cycle behind the left: sin and cos flip sign.
        // A foot lifts while it swings forward.
        const side = LIMB_SIDE[sp.part];
        const swung = turnAbout(sp.center, hip, 0, side * sin * WALK.legAngle);
        const lift = -Math.max(0, -side * cos) * WALK.footLift * s;
        return add(sub(swung, sp.center), [0, lift, 0]);
      }
      return swingArm(sp);
    });
  }

  // No legs: a waddle. A hop per step, rocking onto alternate sides.
  const hopAt = (t: number) =>
    -Math.abs(Math.sin(2 * Math.PI * t)) * WALK.hop * s;
  const hop = hopAt(phase);
  const flop = hopAt(phase - WALK.flopLag);
  const roll = sin * WALK.roll;
  return spheres.map((sp): V3 => {
    if (isSceneFixed(sp.part)) return [0, 0, 0];
    // Rock about the bottom of the creature, so it pivots on its base.
    const [x, y] = sp.center;
    const rx = -(y - rig.floor) * roll;
    const ry = x * roll;
    const dy = sp.part === "ear" || sp.part === "spike" ? flop : hop;
    return add(swingArm(sp), [rx, dy + ry, 0]);
  });
}

/** Sitting (on a bench): the hips come forward and up off the seat, as
 * thighs would (fractions of the body scale, like WALK's)… */
const SIT = {
  hipReach: 0.28,
  hipLift: 0.05,
  /** …and each leg swings forward about its hip, a little short of
   * straight out, so the feet droop (radians). */
  legAngle: (80 * Math.PI) / 180,
} as const;

/** Each sphere's offset when seated, as a delta: legs out in front.
 * Herzies without legs just sit as they stand. */
function sitDeltas(spheres: Sphere[], stage: number): V3[] {
  const zero = spheres.map((): V3 => [0, 0, 0]);
  const rig = buildRig(spheres);
  if (stage < 3 || !rig.legs) return zero;
  const s = HERZIE_BODY.scale * CS;
  const shift: V3 = [0, -SIT.hipLift * s, -SIT.hipReach * s];
  return spheres.map((sp, i) => {
    const hip = rig.hips[sp.part];
    if (!hip) return zero[i];
    const out = turnAbout(sp.center, hip, 0, -SIT.legAngle);
    return add(sub(out, sp.center), shift);
  });
}

/**
 * A sonic cast, as fractions of its whole (castPhase 0..1): the right hand
 * draws back and in (anticipation), snaps out to the front, palm to the
 * target, at RELEASE — when the wave leaves it — holds there through a
 * little recoil (follow-through), and eases home.
 */
export const CAST = {
  /** End of the draw back. */
  drawn: 0.2,
  /** The hand is out: the wave leaves it. */
  release: 0.3,
  /** End of the hold, recoil and all. */
  held: 0.52,
  /** How far behind the shoulder the hand draws (fractions of the arm's
   * reach) and how far past its reach it thrusts. */
  draw: 0.75,
  reach: 1.45,
  /** The recoil: how far the hand gives back after the thrust. */
  recoil: 0.18,
  /** The body leans into the thrust (fractions of the body scale)… */
  lean: 0.09,
  /** …having rocked back on the draw. */
  rock: 0.04,
} as const;

const ease = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeIn = (t: number) => t * t * t;

/** The arm a herzie casts with: the one on its right as you look at its
 * back — the side a third-person camera sits over. (Creature space's +x
 * is its left from behind, once turned upright.) */
export const CAST_ARM = "arm-l";
/** Which way is outward for the casting arm, along creature x. */
const CAST_SIDE = -1;

/** How the hand moves: a sonic wave's palm thrust, a disc's throw, a
 * stick's strike, or a bare-handed jab ("punch", see PUNCH). A "bump"
 * moves no hand: the whole herzie lunges into what's in front of it (see
 * BUMP). */
export type CastStyle = "cast" | "throw" | "strike" | "punch" | "bump";

/**
 * A disc thrown backhand, like a frisbee, on CAST's timeline (so it leaves
 * the hand at CAST.release just the same): the hand crosses in front of the
 * chest (the wind-up), whips out across to the front and its own side as it
 * lets go, carries on round past it (the follow-through) and comes home.
 */
export const THROW = {
  /** How far the hand tucks in at the wind-up, and reaches as it lets go
   * and follows through (arm lengths). */
  tuck: 0.8,
  reach: 1.4,
  follow: 1.25,
  /** The flick's snap back, just after the release. */
  recoil: 0.1,
} as const;

/** Where the casting hand is, `phase` through a cast aimed `pitch` above
 * level, as a direction from the shoulder (creature space: y down, front
 * −z) and how far along it, in arm lengths. `arm` is the arm that casts
 * (CAST_ARM unless it's throwing with its other hand); `style`, how. */
export function castHand(
  phase: number,
  pitch = 0,
  arm: string = CAST_ARM,
  style: CastStyle = "cast",
): { dir: V3; reach: number } {
  const hand =
    style === "throw"
      ? throwHandOutward(phase, pitch)
      : style === "strike"
        ? strikeHandOutward(phase, pitch)
        : style === "punch"
          ? punchHandOutward(phase, pitch)
          : castHandOutward(phase, pitch);
  hand.dir[0] *= LIMB_SIDE[arm] ?? CAST_SIDE;
  return hand;
}

/**
 * A bare-handed jab, on CAST's timeline (it lands at CAST.release): the
 * fist chambers back by its own side, shoots straight out toward the
 * middle of the chest's front (a straight punch, not a palm off to the
 * side), snaps back a touch and comes home. The body turns into it with a
 * deeper lean than a cast's (see castDeltas).
 */
export const PUNCH = {
  /** How far the fist pulls in at the chamber, and reaches at the blow
   * (arm lengths). */
  chamber: 0.75,
  reach: 1.65,
  /** The snap back off the blow. */
  snap: 0.18,
  /** The body's lean into it (fractions of the body scale). */
  lean: 0.16,
} as const;

/** castHand's punch, for an arm on the +x side. */
function punchHandOutward(
  phase: number,
  pitch: number,
): { dir: V3; reach: number } {
  const mix = (a: V3, b: V3, t: number): V3 =>
    norm(add(scale(a, 1 - t), scale(b, t)));
  const rest: V3 = [1, 0, 0];
  // Chambered: by its side, elbow back.
  const chambered: V3 = norm([0.55, 0.1, 0.75]);
  // The blow: straight ahead, a little in toward the middle.
  const front: V3 = norm([0.1, -Math.sin(pitch) - 0.05, -Math.cos(pitch)]);
  if (phase < CAST.drawn) {
    const t = easeOut(phase / CAST.drawn);
    return {
      dir: mix(rest, chambered, t),
      reach: 1 + (PUNCH.chamber - 1) * t,
    };
  }
  if (phase < CAST.release) {
    const t = easeIn((phase - CAST.drawn) / (CAST.release - CAST.drawn));
    return {
      dir: mix(chambered, front, t),
      reach: PUNCH.chamber + (PUNCH.reach - PUNCH.chamber) * t,
    };
  }
  if (phase < CAST.held) {
    const t = (phase - CAST.release) / (CAST.held - CAST.release);
    const snap = Math.sin(Math.min(1, t * 2) * Math.PI) * PUNCH.snap;
    return { dir: front, reach: PUNCH.reach - snap };
  }
  const t = ease(CAST.held, 1, phase);
  return {
    dir: mix(front, rest, t),
    reach: PUNCH.reach + (1 - PUNCH.reach) * t,
  };
}

/** castHand's throw, for an arm on the +x side. */
function throwHandOutward(
  phase: number,
  pitch: number,
): { dir: V3; reach: number } {
  const mix = (a: V3, b: V3, t: number): V3 =>
    norm(add(scale(a, 1 - t), scale(b, t)));
  const rest: V3 = [1, 0, 0];
  // Wound up across the chest, a little low: the disc held flat by the
  // other shoulder.
  const tucked: V3 = [-0.55, 0.12, -0.8];
  // Let go out front, a touch to its own side, along the aim.
  const front: V3 = norm([0.3, -Math.sin(pitch) - 0.05, -Math.cos(pitch)]);
  // Carried round past it, out to the side.
  const after: V3 = norm([0.9, -Math.sin(pitch) * 0.5, -0.45]);
  if (phase < CAST.drawn) {
    const t = easeOut(phase / CAST.drawn);
    return { dir: mix(rest, tucked, t), reach: 1 + (THROW.tuck - 1) * t };
  }
  if (phase < CAST.release) {
    const t = easeIn((phase - CAST.drawn) / (CAST.release - CAST.drawn));
    return {
      dir: mix(tucked, front, t),
      reach: THROW.tuck + (THROW.reach - THROW.tuck) * t,
    };
  }
  if (phase < CAST.held) {
    const t = (phase - CAST.release) / (CAST.held - CAST.release);
    const give = Math.sin(Math.min(1, t * 2) * Math.PI) * THROW.recoil;
    return {
      dir: mix(front, after, easeOut(t)),
      reach: THROW.reach + (THROW.follow - THROW.reach) * t - give,
    };
  }
  const t = ease(CAST.held, 1, phase);
  return {
    dir: mix(after, rest, t),
    reach: THROW.follow + (1 - THROW.follow) * t,
  };
}

/**
 * A stick's strike, on CAST's timeline (it lands at CAST.release): a
 * forehand sweep, nearly level at the chest — the way a third-person camera
 * behind the herzie sees a swing best. The hand cocks out and back by its
 * own shoulder (the wind-up), sweeps round to the front as it lands and
 * comes home. A herzie's arm is too short to cross its body, so the wrist
 * carries the sweep on (see heldSwing): cocked back on the wind-up, it
 * whips the stick through, and rolls it over across the front after —
 * a drummer's wrist.
 */
export const STRIKE = {
  /** Which way the hand points, about the shoulder, at the wind-up, the
   * blow and the end of the follow-through: radians round from straight
   * ahead toward its own side (negative: across the body), and above level
   * (negative: below). */
  wound: { yaw: 2.1, rise: 0.3 },
  struck: { yaw: 0.25, rise: 0.05 },
  follow: { yaw: 0.35, rise: -0.1 },
  /** How far the hand reaches at each (arm lengths). */
  windReach: 1.05,
  reach: 1.4,
  followReach: 1.3,
  /** The stick, in the hand: raised this much off the arm's line… */
  wrist: 0.3,
  /** …and turned round from it, across the body (radians; negative: back
   * behind the arm), at the wind-up, the blow and the end of the
   * follow-through. */
  cock: -0.55,
  whip: 0.2,
  roll: 1.25,
} as const;

/** How far the wrist turns the stick round from the arm's line, `phase`
 * through a strike (see STRIKE's cock, whip and roll). */
export function strikeWrist(phase: number): number {
  const { cock, whip, roll } = STRIKE;
  if (phase < CAST.drawn) return cock * easeOut(phase / CAST.drawn);
  if (phase < CAST.release) {
    const t = easeIn((phase - CAST.drawn) / (CAST.release - CAST.drawn));
    return cock + (whip - cock) * t;
  }
  if (phase < CAST.held) {
    const t = easeOut((phase - CAST.release) / (CAST.held - CAST.release));
    return whip + (roll - whip) * t;
  }
  return roll * (1 - ease(CAST.held, 1, phase));
}

/** A direction about the shoulder, for an arm on the +x side: `yaw` round
 * from straight ahead (−z) toward +x, `rise` above level (y is down). */
function swingDir(yaw: number, rise: number): V3 {
  const c = Math.cos(rise);
  return [Math.sin(yaw) * c, -Math.sin(rise), -Math.cos(yaw) * c];
}

/** castHand's strike, for an arm on the +x side. The hand goes round the
 * shoulder by its yaw, so the sweep keeps its reach rather than cutting
 * in toward the chest. */
function strikeHandOutward(
  phase: number,
  pitch: number,
): { dir: V3; reach: number } {
  const { wound, struck, follow } = STRIKE;
  const at = (
    a: { yaw: number; rise: number },
    b: { yaw: number; rise: number },
    t: number,
    lift = 0,
  ) =>
    swingDir(
      a.yaw + (b.yaw - a.yaw) * t,
      a.rise + (b.rise - a.rise) * t + lift,
    );
  // The blow follows the aim up or down; the sweep either side of it,
  // halfway.
  const aim = { yaw: struck.yaw, rise: struck.rise + pitch };
  if (phase < CAST.drawn) {
    const t = easeOut(phase / CAST.drawn);
    const rest: V3 = [1, 0, 0];
    const cocked = swingDir(wound.yaw, wound.rise + pitch * 0.5);
    return {
      dir: norm(add(scale(rest, 1 - t), scale(cocked, t))),
      reach: 1 + (STRIKE.windReach - 1) * t,
    };
  }
  if (phase < CAST.release) {
    const t = easeIn((phase - CAST.drawn) / (CAST.release - CAST.drawn));
    return {
      dir: at({ ...wound, rise: wound.rise + pitch * 0.5 }, aim, t),
      reach: STRIKE.windReach + (STRIKE.reach - STRIKE.windReach) * t,
    };
  }
  if (phase < CAST.held) {
    // Still fast off the blow, slowing as it runs out.
    const t = easeOut((phase - CAST.release) / (CAST.held - CAST.release));
    return {
      dir: at(aim, { ...follow, rise: follow.rise + pitch * 0.5 }, t),
      reach: STRIKE.reach + (STRIKE.followReach - STRIKE.reach) * t,
    };
  }
  const t = ease(CAST.held, 1, phase);
  const after = swingDir(follow.yaw, follow.rise + pitch * 0.5);
  return {
    dir: norm(add(scale(after, 1 - t), scale([1, 0, 0], t))),
    reach: STRIKE.followReach + (1 - STRIKE.followReach) * t,
  };
}

/** A strike's hold on its stick: the arm swinging, and how much (see
 * heldPoses). */
export interface HeldSwing {
  arm: string;
  weight: number;
  /** How far the wrist turns the stick across the body (see strikeWrist). */
  wrist: number;
}

/** The strike in `pose`, if one's under way. */
export function heldSwing(
  pose: Pick<CreatureMotion, "castPhase" | "castStyle" | "castArm">,
): HeldSwing | undefined {
  if (pose.castPhase === undefined || pose.castStyle !== "strike") return;
  return {
    arm: pose.castArm ?? CAST_ARM,
    weight: castWeight(pose.castPhase),
    wrist: strikeWrist(pose.castPhase),
  };
}

/** A body bump, on CAST's timeline: it rears back on the wind-up, hops
 * forward to hit at CAST.release, and settles back where it stood
 * (fractions of the body scale). */
export const BUMP = {
  rear: 0.12,
  lunge: 0.55,
  hop: 0.14,
} as const;

/** How far forward (and up) a bump has carried the herzie at `phase`, in
 * body scales: [up, forward]. */
function bumpOffset(phase: number): [number, number] {
  if (phase < CAST.drawn) {
    return [0, -BUMP.rear * easeOut(phase / CAST.drawn)];
  }
  if (phase < CAST.release) {
    const t = easeIn((phase - CAST.drawn) / (CAST.release - CAST.drawn));
    return [
      BUMP.hop * Math.sin(t * Math.PI),
      -BUMP.rear + (BUMP.lunge + BUMP.rear) * t,
    ];
  }
  return [0, BUMP.lunge * (1 - ease(CAST.release, 1, phase))];
}

/** How long a catch's jolt takes, in seconds. */
export const CATCH_SECONDS = 0.2;

/** The catching arm's jolt, `phase` 0..1 through a catch, as a share of
 * the arm's radius: knocked back (creature +z) and down by the disc coming
 * home, quickly, then easing back. */
function catchJolt(phase: number): V3 {
  const p = Math.min(1, Math.max(0, phase));
  const k = Math.sin(Math.sqrt(p) * Math.PI) * (1 - p * 0.3);
  return [0, 0.25 * k, 0.6 * k];
}

/** castHand, for an arm on the +x side. */
function castHandOutward(
  phase: number,
  pitch: number,
): { dir: V3; reach: number } {
  const back: V3 = [0.55, 0.15, 0.82];
  // Out front and a little to its side, palm to the target: clear of the
  // body, so it reads from behind (where the camera is) as well as from
  // the front.
  const front: V3 = [0.42, -Math.sin(pitch) - 0.12, -Math.cos(pitch)];
  const mix = (a: V3, b: V3, t: number): V3 => {
    const v = add(scale(a, 1 - t), scale(b, t));
    return scale(v, 1 / Math.max(1e-9, Math.hypot(...v)));
  };
  if (phase < CAST.drawn) {
    const t = easeOut(phase / CAST.drawn);
    return { dir: mix([1, 0, 0], back, t), reach: 1 + (CAST.draw - 1) * t };
  }
  if (phase < CAST.release) {
    const t = easeIn((phase - CAST.drawn) / (CAST.release - CAST.drawn));
    return {
      dir: mix(back, front, t),
      reach: CAST.draw + (CAST.reach - CAST.draw) * t,
    };
  }
  if (phase < CAST.held) {
    // A quick give, then steady.
    const t = (phase - CAST.release) / (CAST.held - CAST.release);
    const give = Math.sin(Math.min(1, t * 2) * Math.PI) * CAST.recoil;
    return { dir: front, reach: CAST.reach - give };
  }
  const t = ease(CAST.held, 1, phase);
  return {
    dir: mix(front, [1, 0, 0], t),
    reach: CAST.reach + (1 - CAST.reach) * t,
  };
}

/** How much a cast takes over the pose at `phase`: in quickly, out as the
 * hand comes home, so it blends with the walk either side. */
export function castWeight(phase: number): number {
  return ease(0, 0.06, phase) * (1 - ease(0.75, 1, phase));
}

/** Each sphere's offset at `phase` through a cast, as a delta from rest:
 * the right arm, and a lean of everything with it. */
function castDeltas(
  spheres: Sphere[],
  phase: number,
  pitch: number,
  arm: string = CAST_ARM,
  style: CastStyle = "cast",
): V3[] {
  const rig = buildRig(spheres);
  const s = HERZIE_BODY.scale * CS;
  if (style === "bump") {
    // Everything but the legs (which stay planted, so it reads as a lunge
    // off them) goes with it.
    const [up, forward] = bumpOffset(phase);
    return spheres.map(
      (sp): V3 =>
        isSceneFixed(sp.part) || isLeg(sp.part)
          ? [0, 0, 0]
          : [0, -up * s, -forward * s],
    );
  }
  // Back on the draw, into the thrust, settling after (deeper for a
  // punch: the body goes with the fist).
  const into = style === "punch" ? PUNCH.lean : CAST.lean;
  const lean =
    phase < CAST.release
      ? -CAST.rock * ease(0, CAST.drawn, phase) +
        (CAST.rock + into) *
          easeIn(Math.max(0, phase - CAST.drawn) / (CAST.release - CAST.drawn))
      : into * (1 - ease(CAST.release, 1, phase));
  const shoulder = rig.shoulders[arm];
  const hand = castHand(phase, pitch, arm, style);
  return spheres.map((sp): V3 => {
    if (isSceneFixed(sp.part) || isLeg(sp.part)) return [0, 0, 0];
    const leaning: V3 = [0, 0, -lean * s];
    if (sp.part !== arm || !shoulder) return leaning;
    const length = Math.hypot(...sub(sp.center, shoulder));
    const at = add(shoulder, scale(hand.dir, length * hand.reach));
    return add(sub(at, sp.center), leaning);
  });
}

/**
 * How far a seated herzie settles below where its feet stood, in creature
 * units: with its legs out, it rests on its bottom. 0 without legs.
 */
export function creatureSeatDrop(spheres: Sphere[], stage: number): number {
  const sit = sitDeltas(spheres, stage);
  let standing = Number.NEGATIVE_INFINITY;
  let seated = Number.NEGATIVE_INFINITY;
  spheres.forEach((sp, i) => {
    if (isSceneFixed(sp.part)) return;
    standing = Math.max(standing, sp.center[1] + sp.radius);
    seated = Math.max(seated, sp.center[1] + sit[i][1] + sp.radius);
  });
  return Math.max(0, standing - seated);
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

function axisLength(axis: V3): number {
  return Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
}

/** Distance along a unit ray to where it first enters `p`, or -1 for a miss.
 * Exported for tests. Capsules, cylinders and cones are convex, so the first
 * hit is the nearest of their surfaces' hits: the side, then either the flat
 * caps (cylinder, cone) or the end spheres (capsule). */
export function rayPrimitive(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  p: Primitive,
): number {
  const [cx, cy, cz] = p.center;
  const r = p.radius;
  const shape = p.shape;
  if (!shape) return raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r);

  const h = axisLength(shape.axis);
  if (h < 1e-9) return raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r);
  const ux = shape.axis[0] / h;
  const uy = shape.axis[1] / h;
  const uz = shape.axis[2] / h;

  // Work in the axis' frame: `along` is the position along it, the rest is
  // perpendicular to it.
  const lx = ox - cx;
  const ly = oy - cy;
  const lz = oz - cz;
  const along = lx * ux + ly * uy + lz * uz;
  const dAlong = dx * ux + dy * uy + dz * uz;
  const px = lx - ux * along;
  const py = ly - uy * along;
  const pz = lz - uz * along;
  const qx = dx - ux * dAlong;
  const qy = dy - uy * dAlong;
  const qz = dz - uz * dAlong;

  let best = Number.POSITIVE_INFINITY;
  const a = qx * qx + qy * qy + qz * qz;
  if (shape.kind === "cone") {
    // The side's radius runs linearly from r at −axis to the tip's at +axis:
    // ρ(s) = mid + slope·s. Squared along the ray, a quadratic in t; it also
    // meets the mirrored cone past the apex, which the range check drops.
    const tip = shape.tipRadius ?? 0;
    const slope = (tip - r) / (2 * h);
    const r0 = (r + tip) / 2 + slope * along;
    const ka = a - slope * slope * dAlong * dAlong;
    const kb = 2 * (px * qx + py * qy + pz * qz - slope * r0 * dAlong);
    const kc = px * px + py * py + pz * pz - r0 * r0;
    const sideHit = (t: number) => {
      const s = along + t * dAlong;
      if (t > 0 && t < best && Math.abs(s) <= h && r0 + slope * t * dAlong >= 0)
        best = t;
    };
    if (Math.abs(ka) < 1e-12) {
      if (Math.abs(kb) > 1e-12) sideHit(-kc / kb);
    } else {
      const disc = kb * kb - 4 * ka * kc;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        sideHit((-kb - sq) / (2 * ka));
        sideHit((-kb + sq) / (2 * ka));
      }
    }
    if (Math.abs(dAlong) > 1e-12) {
      for (let side = -1; side <= 1; side += 2) {
        const t = (side * h - along) / dAlong;
        if (t <= 0 || t >= best) continue;
        const ex = px + qx * t;
        const ey = py + qy * t;
        const ez = pz + qz * t;
        const cap = side < 0 ? r : tip;
        if (ex * ex + ey * ey + ez * ez <= cap * cap) best = t;
      }
    }
    return best === Number.POSITIVE_INFINITY ? -1 : best;
  }
  if (a > 1e-12) {
    const b = 2 * (px * qx + py * qy + pz * qz);
    const c = px * px + py * py + pz * pz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t > 0 && Math.abs(along + t * dAlong) <= h) best = t;
    }
  }

  if (shape.kind === "capsule") {
    for (let side = -1; side <= 1; side += 2) {
      const t = raySphere(
        ox,
        oy,
        oz,
        dx,
        dy,
        dz,
        cx + ux * h * side,
        cy + uy * h * side,
        cz + uz * h * side,
        r,
      );
      if (t > 0 && t < best) best = t;
    }
  } else if (shape.dome) {
    // A domed end sits where side·along = h + dome·(1 − ρ²/r²), ρ being the
    // distance from the axis; along the ray that's a quadratic in t. Dished
    // (dome < 0), the solid isn't convex, but the camera is outside it, so
    // the nearest surface hit is still where the ray enters.
    const k = -shape.dome / (r * r);
    const ka = k * a;
    const kc = k * (px * px + py * py + pz * pz) + h + shape.dome;
    const pq = 2 * k * (px * qx + py * qy + pz * qz);
    // Both roots matter: a slanted ray can cross the paraboloid out past the
    // rim (not on the cup) before it meets the end itself.
    const tryHit = (t: number) => {
      if (t <= 0 || t >= best) return;
      const ex = px + qx * t;
      const ey = py + qy * t;
      const ez = pz + qz * t;
      if (ex * ex + ey * ey + ez * ez <= r * r) best = t;
    };
    for (let side = -1; side <= 1; side += 2) {
      const qb = pq - side * dAlong;
      const qc = kc - side * along;
      if (Math.abs(ka) < 1e-12) {
        if (Math.abs(qb) > 1e-12) tryHit(-qc / qb);
        continue;
      }
      const disc = qb * qb - 4 * ka * qc;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      tryHit((-qb - sq) / (2 * ka));
      tryHit((-qb + sq) / (2 * ka));
    }
  } else if (Math.abs(dAlong) > 1e-12) {
    for (let side = -1; side <= 1; side += 2) {
      const t = (side * h - along) / dAlong;
      if (t <= 0 || t >= best) continue;
      const ex = px + qx * t;
      const ey = py + qy * t;
      const ez = pz + qz * t;
      if (ex * ex + ey * ey + ez * ez <= r * r) best = t;
    }
  }

  return best === Number.POSITIVE_INFINITY ? -1 : best;
}

/** The unit surface normal of `p` at a point on its surface. Exported for
 * tests. */
export function primitiveNormal(p: Primitive, hit: V3): V3 {
  const [cx, cy, cz] = p.center;
  const lx = hit[0] - cx;
  const ly = hit[1] - cy;
  const lz = hit[2] - cz;
  const shape = p.shape;
  const h = shape ? axisLength(shape.axis) : 0;
  if (!shape || h < 1e-9) {
    return [lx / p.radius, ly / p.radius, lz / p.radius];
  }
  const ux = shape.axis[0] / h;
  const uy = shape.axis[1] / h;
  const uz = shape.axis[2] / h;
  const along = lx * ux + ly * uy + lz * uz;
  const ex = lx - ux * along;
  const ey = ly - uy * along;
  const ez = lz - uz * along;
  const radial = Math.sqrt(ex * ex + ey * ey + ez * ez);

  if (shape.kind === "capsule") {
    // Away from the nearest point on the segment.
    const s = Math.max(-h, Math.min(h, along));
    const nx = lx - ux * s;
    const ny = ly - uy * s;
    const nz = lz - uz * s;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return [nx / len, ny / len, nz / len];
  }
  const r = p.radius;
  if (shape.kind === "cone") {
    // On an end if nearer it than the side, else out from the axis, tipped
    // toward the narrow end by the side's slant.
    const tip = shape.tipRadius ?? 0;
    const slope = (tip - r) / (2 * h);
    const rho = (r + tip) / 2 + slope * along;
    if (h - Math.abs(along) < Math.abs(rho - radial) || radial < 1e-9) {
      const sign = along < 0 ? -1 : 1;
      return [ux * sign, uy * sign, uz * sign];
    }
    const nx = ex / radial - ux * slope;
    const ny = ey / radial - uy * slope;
    const nz = ez / radial - uz * slope;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    return [nx / len, ny / len, nz / len];
  }
  // Cylinder: on whichever surface the point is nearest, an end or the side.
  const dome = shape.dome ?? 0;
  const endAlong = h + dome * (1 - (radial * radial) / (r * r));
  if (Math.abs(endAlong - Math.abs(along)) < r - radial || radial < 1e-9) {
    const sign = along < 0 ? -1 : 1;
    if (!dome || radial < 1e-9) return [ux * sign, uy * sign, uz * sign];
    // The cap's slope tips the normal out from the axis (in, when dished).
    const slope = (-2 * dome) / (r * r);
    const nx = ux * sign - ex * slope;
    const ny = uy * sign - ey * slope;
    const nz = uz * sign - ez * slope;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    return [nx / len, ny / len, nz / len];
  }
  return [ex / radial, ey / radial, ez / radial];
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

/**
 * How a primitive is shaded, for a host drawing the model with its own
 * lights. Mirrors renderCreatureFrame: with `diffuse` the light's
 * max(0, n·l),
 *
 *   lit = (gain + texture) · (floor + (1 − floor) · diffuse)
 *
 * (texture only when `textured`, see applyTexture), and the colour is
 * `shades[2]` above `hi`, `shades[1]` above `lo`, else `shades[0]`. A
 * scheme-painted primitive takes its shades from the scheme's band at the
 * height drawn instead (see schemeShades).
 */
export interface PrimitiveShading {
  gain: number;
  floor: number;
  textured: boolean;
  lo: number;
  hi: number;
  /** dim, base, bright. */
  shades: [string, string, string];
  schemePainted: boolean;
  /** Polished metal: see herzieMaterial. Absent otherwise. */
  metal?: true;
}

/** The shades shadeWearableColor gives `hex`, dim to bright. */
function wearableShades(hex: string): [string, string, string] {
  return [
    shadeWearableColor(hex, 0),
    shadeWearableColor(hex, 0.45),
    shadeWearableColor(hex, 1),
  ];
}

export function primitiveShading(
  sp: Pick<Sphere, "zone" | "color" | "finish">,
  colors: ColorTriplet,
  scheme?: readonly string[],
): PrimitiveShading {
  // Lighting goes by zone, then by an own colour — as renderCreatureFrame's
  // `lit` does.
  let gain = 0.5;
  let floor = 0.15;
  let textured = false;
  if (sp.zone === "pupil") gain = 0;
  else if (sp.zone === "eye") gain = 0.75;
  else if (sp.zone === "eye-evil") {
    gain = 1;
    floor = 0.55;
  } else if (sp.color) {
    gain = 0.7;
    floor = 0.3;
  } else textured = true;

  // Colour goes by an own colour, then the scheme, then the zone — as its
  // cell colours do.
  const shading = (
    lo: number,
    hi: number,
    shades: [string, string, string],
    schemePainted = false,
  ): PrimitiveShading => ({
    gain,
    floor,
    textured,
    lo,
    hi,
    shades,
    schemePainted,
  });
  if (sp.color && sp.finish === "metal") {
    // Its own bands, as paint's: herzieMaterial darkens them under what it
    // mirrors.
    return { ...shading(0.3, 0.6, wearableShades(sp.color)), metal: true };
  }
  if (sp.color) return shading(0.3, 0.6, wearableShades(sp.color));
  if (scheme && isSchemePaintable(sp.zone, false)) {
    return shading(0.3, 0.6, wearableShades(scheme[0]), true);
  }
  switch (sp.zone) {
    case "eye":
      return shading(0.3, 0.6, [EYE_COLOR, EYE_COLOR, EYE_COLOR]);
    case "eye-evil":
      return shading(0.34, 0.62, [
        EVIL_EYE_DIM,
        EVIL_EYE_BASE,
        EVIL_EYE_BRIGHT,
      ]);
    case "pupil":
      return shading(0.3, 0.6, ["#111111", "#111111", "#111111"]);
    case "accent":
      return shading(0.45, Number.POSITIVE_INFINITY, [
        colors.dim,
        colors.base,
        colors.base,
      ]);
    case "dark":
      return shading(0.3, 0.6, [colors.dim, colors.dim, colors.dim]);
    case "wearable":
      return shading(0.3, 0.6, ["#444", "#666", "#888"]);
    default:
      return shading(0.3, 0.6, [colors.dim, colors.base, colors.bright]);
  }
}

/** Each band of a colour scheme's shades (dim, base, bright), top band
 * first: the scheme paints by height, splitting the painted surface's span
 * into equal bands. */
export function schemeShades(
  scheme: readonly string[],
): [string, string, string][] {
  return scheme.map(wearableShades);
}

/** The bounds of the scheme-painted surface on the y axis (creature space, y
 * down): the span schemeShades' bands divide. */
export function schemeSpan(spheres: Sphere[]): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const sp of spheres) {
    if (!isSchemePaintable(sp.zone, Boolean(sp.color))) continue;
    min = Math.min(min, sp.center[1] - sp.radius);
    max = Math.max(max, sp.center[1] + sp.radius);
  }
  return [min, max];
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
    // Ground props (e.g. the boombox) and the Spirit Orb ("spirit") are both
    // anchored to the scene, not the creature — they keep their facing as the
    // herzie spins around its Y axis (manual drag-rotation shouldn't drag the
    // orb along with it). The orb gets its own independent breathing bob
    // instead, via applyIdleOffsets.
    const isFixed =
      s.part === "ground" || s.part === "spirit" || s.part === "pet";
    // Rotations are linear, so a shape's axis turns exactly as a point does.
    const view = (p: V3): V3 => {
      if (pitch !== undefined) {
        const turned = isFixed ? p : rotY(p, yAngle);
        return [
          turned[0],
          turned[1] * pitchCos - turned[2] * pitchSin,
          turned[1] * pitchSin + turned[2] * pitchCos,
        ];
      }
      const tilted: V3 = [
        p[0],
        p[1] * TILT_COS - p[2] * TILT_SIN,
        p[1] * TILT_SIN + p[2] * TILT_COS,
      ];
      return isFixed ? tilted : rotY(tilted, yAngle);
    };
    return {
      center: view(s.center),
      radius: s.radius,
      zone: s.zone,
      part: s.part,
      color: s.color,
      shape: s.shape && { ...s.shape, axis: view(s.shape.axis) },
      // A sphere enclosing the primitive, for a cheap reject per ray.
      bound: s.shape
        ? s.radius + axisLength(s.shape.axis) + Math.abs(s.shape.dome ?? 0)
        : s.radius,
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
        // Runs for every primitive in every cell. Nearly everything is a
        // sphere, tested directly; a shape only gets the full test once the
        // ray hits its bounding sphere.
        const t = sp.shape
          ? raySphere(
              0,
              0,
              oz,
              dx,
              dy,
              dz,
              sp.center[0],
              sp.center[1],
              sp.center[2],
              sp.bound,
            ) > 0
            ? rayPrimitive(0, 0, oz, dx, dy, dz, sp)
            : -1
          : raySphere(
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

      const normal = primitiveNormal(sp, [hx, hy, hz]);
      const [nx, ny, nz] = normal;
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

/** How long each frame of the rotation loop shows, in ms (the old renderer's tick). */
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
  /** Pose for anything dangling, from the host's spin physics. */
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
  /** How far its class gear is drawn (see CreatureMotion). */
  drawPhase?: number;
  /** How far gear on threads has swung (see CreatureMotion). */
  heldSway?: Readonly<Record<string, V3>>;
}

/** Frames in the idle loop, played at 50ms a frame. */
export const IDLE_LOOP_FRAMES = IDLE_FRAMES;

/** A herzie and everything it wears, in creature space (y down, front −z),
 * with what its colours are made from: what the ray caster draws, and what
 * a real-3D host (the Town) builds meshes from. */
export interface CreatureModel {
  spheres: Sphere[];
  colors: ColorTriplet;
  /** The colour scheme painting it (a prism…), if any. */
  scheme: readonly string[] | undefined;
  textureType: number;
}

/**
 * Builds a herzie's model. Props placed at the frame's edge (a floating pet)
 * are placed against `cols` x `rows`, the grid it would be drawn on.
 */
export function buildCreatureModel(
  userId: string,
  stage: number,
  equipped?: Equipped,
  paramsOverride?: CreatureParams,
  cols: number = SW,
  rows: number = SH,
): CreatureModel {
  const params = resolveCreatureParams(userId, paramsOverride);
  const spheres = buildCreatureSpheres(params, stage);
  appendWearableSpheres(spheres, equipped, layoutCols(cols, rows));
  return {
    spheres,
    colors: buildColorTriplet(CREATURE_PALETTE[params.colorIndex]),
    scheme: colorSchemeFor(equipped, params),
    textureType: params.textureType,
  };
}

/** Frames in the dance loop, which the old renderer played at 65ms a
 * frame (a 1.56s loop). */
export const DANCE_LOOP_FRAMES = DANCE_FRAMES;
/** Frames between the dance's beats (the boombox's touchdowns). */
export const DANCE_BEAT_FRAMES = DANCE_BEAT;

/** What a continuously animating host poses a herzie with (see
 * creaturePoseOffsets). */
export type CreatureMotion = Pick<
  CreaturePose,
  "idleFrame" | "walkPhase" | "walkWeight"
> & {
  /** Frame of the dance loop, 0..DANCE_LOOP_FRAMES (may be fractional). */
  danceFrame?: number;
  /** 0 not dancing to 1 dancing (music playing). */
  danceWeight?: number;
  /** The Greedy Spirit's hop variant for this dance loop, if any (see
   * SPIRIT_DANCE_HOP_VARIANT_COUNT). */
  spiritHopVariant?: number;
  /** How far anything worn that dangles (the chain, the pearls) swings. */
  dangle?: DangleState;
  /** 0 standing to 1 seated (on a bench): legs out in front. */
  sitWeight?: number;
  /** How far through a sonic cast it is, 0..1 (see CAST); undefined when
   * it isn't casting. */
  castPhase?: number;
  /** Where the cast is aimed: radians above level (negative: below). */
  castPitch?: number;
  /** The arm that casts (CAST_ARM unless given), and how (see THROW). */
  castArm?: string;
  castStyle?: CastStyle;
  /** How far through a catch's jolt `catchArm` is, 0..1 (see
   * CATCH_SECONDS); undefined when it isn't catching. */
  catchPhase?: number;
  catchArm?: string;
  /** How far its class gear is drawn: 0 slung on its back to 1 in its
   * hands (see DRAW). */
  drawPhase?: number;
  /** How far gear hanging on threads on its back has swung from where it
   * rests, by held part (see thread-physics.ts). */
  heldSway?: Readonly<Record<string, V3>>;
};

/**
 * Each sphere's offset from its rest position in a pose: the idle loop
 * blended into the walk cycle by `walkWeight` and into the dance by
 * `danceWeight`, with anything dangling swung by `dangle`. `idleFrame` and
 * `danceFrame` may be fractional, for a host animating continuously.
 */
export function creaturePoseOffsets(
  spheres: Sphere[],
  stage: number,
  pose: CreatureMotion,
): V3[] {
  const base = pose.dangle ? applyDangle(spheres, pose.dangle) : spheres;
  const w = Math.min(1, Math.max(0, pose.walkWeight));
  const dw = Math.min(1, Math.max(0, pose.danceWeight ?? 0));
  const idle = idleDeltas(base, pose.idleFrame);
  const walk = w > 0 ? walkDeltas(base, pose.walkPhase, stage) : null;
  const sw = Math.min(1, Math.max(0, pose.sitWeight ?? 0));
  const sit = sw > 0 ? sitDeltas(base, stage) : null;
  const dance =
    dw > 0
      ? applyDanceOffsets(
          base,
          pose.danceFrame ?? 0,
          hasSpiritPart(base)
            ? spiritHopsFor(pose.spiritHopVariant)
            : undefined,
        )
      : null;
  const cast =
    pose.castPhase !== undefined
      ? castDeltas(
          base,
          pose.castPhase,
          pose.castPitch ?? 0,
          pose.castArm,
          pose.castStyle,
        )
      : null;
  const castArm = pose.castArm ?? CAST_ARM;
  const cw = pose.castPhase !== undefined ? castWeight(pose.castPhase) : 0;
  const drawPhase = Math.min(1, Math.max(0, pose.drawPhase ?? 0));
  const draw = drawPhase > 0 ? drawArmDeltas(base, drawPhase) : null;
  const offsets = spheres.map((s, i): V3 => {
    const b = base[i].center;
    // Scene-anchored parts (a floating pet) keep their own idle bob even
    // mid-stride; everything else fades from idle into the walk.
    const iw = walk && !isSceneFixed(s.part) ? 1 - w : 1;
    const d = walk?.[i];
    let x = idle[i][0] * iw + (d ? d[0] * w : 0);
    let y = idle[i][1] * iw + (d ? d[1] * w : 0);
    let z = idle[i][2] * iw + (d ? d[2] * w : 0);
    const seated = sit?.[i];
    if (seated) {
      x += seated[0] * sw;
      y += seated[1] * sw;
      z += seated[2] * sw;
    }
    const moved = dance?.[i].center;
    if (moved) {
      x = x * (1 - dw) + (moved[0] - b[0]) * dw;
      y = y * (1 - dw) + (moved[1] - b[1]) * dw;
      z = z * (1 - dw) + (moved[2] - b[2]) * dw;
    }
    // Drawing gear takes its arm over (at the ready, it keeps some sway).
    const held = draw?.weight[i] ?? 0;
    if (draw && held > 0) {
      const g = draw.deltas[i];
      const keep = draw.keeps[i];
      x = x * keep + g[0] * held;
      y = y * keep + g[1] * held;
      z = z * keep + g[2] * held;
    }
    // A cast takes the casting arm over; the lean adds to whatever else.
    const c = cast?.[i];
    if (c) {
      const own = s.part === castArm && pose.castStyle !== "bump" ? cw : 0;
      x = x * (1 - own) + c[0] * cw;
      y = y * (1 - own) + c[1] * cw;
      z = z * (1 - own) + c[2] * cw;
    }
    // A disc caught: its arm jolted back.
    if (pose.catchPhase !== undefined && s.part === pose.catchArm) {
      const j = catchJolt(pose.catchPhase);
      x += j[0] * s.radius;
      y += j[1] * s.radius;
      z += j[2] * s.radius;
    }
    // Plus where the swing put it.
    return [
      x + b[0] - s.center[0],
      y + b[1] - s.center[1],
      z + b[2] - s.center[2],
    ];
  });
  return grounded(
    spheres,
    holdProps(spheres, offsets, drawPhase, pose.heldSway, heldSwing(pose)),
    1 - sw,
  );
}

/**
 * `offsets` with the herzie moved up or down so its lowest foot is on the
 * ground, by `weight` (0 seated, when it rests on its bottom instead). Each
 * motion keeps a foot planted on its own; blended together they needn't,
 * and this is what keeps a herzie from floating or sinking. It's also the
 * walk's bob: the body drops as the legs spread. No legs, no change.
 */
function grounded(spheres: Sphere[], offsets: V3[], weight: number): V3[] {
  if (weight <= 0) return offsets;
  let rest = Number.NEGATIVE_INFINITY;
  let lowest = Number.NEGATIVE_INFINITY;
  spheres.forEach((sp, i) => {
    if (!isLeg(sp.part)) return;
    rest = Math.max(rest, sp.center[1] + sp.radius);
    lowest = Math.max(lowest, sp.center[1] + offsets[i][1] + sp.radius);
  });
  if (rest === Number.NEGATIVE_INFINITY) return offsets;
  const dy = (rest - lowest) * weight;
  if (Math.abs(dy) < 1e-12) return offsets;
  return offsets.map((d, i) =>
    isSceneFixed(spheres[i].part) ? d : [d[0], d[1] + dy, d[2]],
  );
}

function hasSpiritPart(spheres: Sphere[]): boolean {
  return spheres.some((s) => s.part === "spirit");
}

/** Built models for renderCreaturePose, which a host calls every frame:
 * building a creature and its wearables is pure, so it's done once per
 * look. Bounded, since every distinct look adds an entry. */
const poseBuildCache = new Map<
  string,
  CreatureModel & { anchors: AnchorPoint[] }
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
    const model = buildCreatureModel(
      userId,
      stage,
      equipped,
      paramsOverride,
      cols,
      rows,
    );
    built = {
      ...model,
      anchors: getAnchors(
        model.spheres,
        resolveCreatureParams(userId, paramsOverride),
        stage,
      ),
    };
    if (poseBuildCache.size >= POSE_BUILD_CACHE_MAX) {
      const oldest = poseBuildCache.keys().next().value;
      if (oldest !== undefined) poseBuildCache.delete(oldest);
    }
    poseBuildCache.set(key, built);
  }

  const { spheres } = built;
  const offsets = creaturePoseOffsets(spheres, stage, pose);
  const held = heldPoses(spheres, offsets, pose.drawPhase ?? 0, pose.heldSway);
  const animated = spheres.map((s, i) => {
    const d = offsets[i];
    const prop = s.shape && held[s.part];
    return {
      ...s,
      center: [
        s.center[0] + d[0],
        s.center[1] + d[1],
        s.center[2] + d[2],
      ] as V3,
      shape:
        prop && s.shape
          ? { ...s.shape, axis: prop.turn(s.shape.axis) }
          : s.shape,
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
