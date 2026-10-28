/**
 * The cloaks (the back slot): how each is cut, what it's made of and how
 * its cloth moves, and how a herzie's body is handed to the cloth sim
 * (cloak-physics.ts) as something to hang on and collide with.
 *
 * Drawn only in the 3D view (HerzieModel). The ray caster and the visitor
 * icons it draws don't show a cloak.
 */

import {
  type CloakBody,
  type CloakColliders,
  type CloakConfig,
  type CloakShape,
  COLLIDER_STRIDE,
  DEFAULT_CLOAK_CONFIG,
  type V3,
} from "./cloak-physics.js";
import type { Sphere } from "./creature-renderer.js";
import type { Equipped } from "./items.js";

/** What a cloak's outside looks like, besides its colour (herzieMaterial's
 * CLOTH variant). */
export const CLOTH_FINISH = {
  velvet: 1,
  vinyl: 2,
  hide: 3,
  silk: 4,
} as const;
export type ClothFinish = keyof typeof CLOTH_FINISH;

export interface CloakStyle {
  shape: CloakShape;
  config: CloakConfig;
  /** Outside, lining (the inside), and the trim at the collar and hem. */
  outer: string;
  lining: string;
  trim: string;
  /** The brooches at the collar's ends. */
  clasp: string;
  finish: ClothFinish;
  /** How deep the trim runs, as a fraction of the cloak's length, at the
   * hem and at the collar. */
  hemTrim: number;
  collarTrim: number;
}

/** How far slung gear (an instrument on the back) sits further out over a
 * cloak, in creature units: the cloth's thickness and a little air. */
export const CLOAK_CLEARANCE = 0.07;

const COLS = 15;
const ROWS = 14;

export const CLOAK_STYLES: Readonly<Record<string, CloakStyle>> = {
  // Royal purple velvet, a gold edge: light, billowy, soft folds.
  "troubadour-mantle": {
    shape: {
      cols: COLS,
      rows: ROWS,
      length: 0.97,
      collarHalf: 1.3,
      flare: 1.75,
      hem: "round",
      gather: 1.3,
    },
    config: {
      ...DEFAULT_CLOAK_CONFIG,
      gravity: 52,
      damping: 1.4,
      drag: 1.35,
      bend: 6e-4,
      turbulence: 0.26,
    },
    outer: "#7b3fb8",
    lining: "#e8c35a",
    trim: "#f2cf5b",
    clasp: "#f2cf5b",
    finish: "velvet",
    hemTrim: 0.07,
    collarTrim: 0.06,
  },
  // Glossy black, its grooves catching the light; a red label lining and a
  // dagged hem. Snappy: stiffer, quick to swing back.
  "groove-cape": {
    shape: {
      cols: COLS,
      rows: ROWS,
      length: 0.9,
      collarHalf: 1.22,
      flare: 1.6,
      hem: "dagged",
      gather: 1.15,
    },
    config: {
      ...DEFAULT_CLOAK_CONFIG,
      gravity: 58,
      damping: 1.9,
      drag: 1.05,
      bend: 2e-4,
      turbulence: 0.2,
    },
    outer: "#2a2a33",
    lining: "#d8373f",
    trim: "#b8b8c8",
    clasp: "#d8d8e8",
    finish: "vinyl",
    hemTrim: 0.05,
    collarTrim: 0.05,
  },
  // Heavy oxblood hide, brass-studded: stiff, slow, weighty.
  "drumhide-cloak": {
    shape: {
      cols: COLS,
      rows: ROWS,
      length: 0.93,
      collarHalf: 1.26,
      flare: 1.5,
      hem: "straight",
      gather: 1.12,
    },
    config: {
      ...DEFAULT_CLOAK_CONFIG,
      gravity: 62,
      damping: 2.4,
      drag: 0.75,
      bend: 6e-5,
      turbulence: 0.12,
      friction: 0.5,
    },
    outer: "#7a2e24",
    lining: "#c9a27a",
    trim: "#c9a03e",
    clasp: "#d6ae48",
    finish: "hide",
    hemTrim: 0.08,
    collarTrim: 0.07,
  },
  // Sky-to-teal silk, long and light, split into two tails that stream.
  "tailwind-cloak": {
    shape: {
      cols: COLS,
      rows: ROWS,
      length: 1.0,
      collarHalf: 1.18,
      flare: 1.4,
      hem: "swallowtail",
      gather: 1.2,
    },
    config: {
      ...DEFAULT_CLOAK_CONFIG,
      gravity: 46,
      damping: 1.2,
      drag: 1.6,
      airFriction: 0.18,
      bend: 1.5e-3,
      turbulence: 0.4,
      friction: 0.25,
    },
    outer: "#5cc8e8",
    lining: "#e9fbff",
    trim: "#ffffff",
    clasp: "#f4f8ff",
    finish: "silk",
    hemTrim: 0.04,
    collarTrim: 0.05,
  },
};

/** The cloak a herzie wears, if any (and it can: stage 3, a torso). */
export function cloakStyleFor(
  equipped: Equipped | null | undefined,
): CloakStyle | null {
  const id = equipped?.back;
  return (id && CLOAK_STYLES[id]) || null;
}

/** The parts the cloth hangs on and touches. Eyes, ears, wearables and the
 * floating companion don't count: the cloth hangs behind them, or they're
 * too small to matter. */
const TOUCHES = new Set([
  "head",
  "body",
  "arm-l",
  "arm-r",
  "leg-l",
  "leg-r",
  "spike",
]);

const ARMS = new Set(["arm-l", "arm-r"]);
/** The arms to the simulated cloth, as a share of their radius. */
const ARM_SLIM = 0.82;

/** The torso and head a cloak hangs from (the biggest of each), or null
 * without them — a herzie before stage 3, the boss. */
export function cloakBodyOf(spheres: readonly Sphere[], feetY: number) {
  let body = -1;
  let head = -1;
  spheres.forEach((s, i) => {
    if (s.zone === "wearable") return;
    if (s.part === "body" && (body < 0 || s.radius > spheres[body].radius))
      body = i;
    if (s.part === "head" && (head < 0 || s.radius > spheres[head].radius))
      head = i;
  });
  if (body < 0 || head < 0) return null;
  const cloakBody: CloakBody = {
    body: {
      center: [...spheres[body].center] as V3,
      radius: spheres[body].radius,
    },
    head: {
      center: [...spheres[head].center] as V3,
      radius: spheres[head].radius,
    },
    ground: feetY,
  };
  return { cloakBody, bodyAt: body, headAt: head };
}

/** Which of `spheres` the cloth collides with, by index. */
export function cloakColliderParts(spheres: readonly Sphere[]): number[] {
  // A spiky herzie's crest sits on top of its head, out of the cloth's
  // reach (and differs herzie to herzie, which would cost each its own
  // settling): only the spikes on its flanks count.
  let headY = Number.NEGATIVE_INFINITY;
  for (const s of spheres) {
    if (s.part === "head" && s.zone !== "wearable") headY = s.center[1];
  }
  const out: number[] = [];
  spheres.forEach((s, i) => {
    if (s.zone === "wearable" || s.shape) return;
    if (s.part === "spike" && s.center[1] < headY) return;
    if (TOUCHES.has(s.part)) out.push(i);
  });
  return out;
}

/**
 * Fills `out` with the body's colliders as posed: a sphere for each part in
 * `parts` (centred at `centerOf(i)`), and a capsule down the neck from the
 * head's middle to the torso's, as wide as where the two meet — so the
 * cloth can't fold into the crease between them. Returns `out` (made the
 * right size if it isn't).
 */
export function cloakColliders(
  spheres: readonly Sphere[],
  parts: readonly number[],
  headAt: number,
  bodyAt: number,
  centerOf: (i: number) => V3,
  out?: CloakColliders,
  /** How much slimmer the arms are to the cloth (ARM_SLIM for the sim;
   * 1, as drawn, for what's seen — see HerzieModel.drawCloak). */
  armScale = ARM_SLIM,
): CloakColliders {
  const size = (parts.length + 1) * COLLIDER_STRIDE;
  const cols = out && out.length === size ? out : new Float32Array(size);
  parts.forEach((i, j) => {
    const c = centerOf(i);
    const o = j * COLLIDER_STRIDE;
    cols[o] = c[0];
    cols[o + 1] = c[1];
    cols[o + 2] = c[2];
    cols[o + 3] = c[0];
    cols[o + 4] = c[1];
    cols[o + 5] = c[2];
    // Arms a little slimmer to the cloth: a cloak drapes over the shoulder
    // where the arm sinks into the torso, and a raised arm mustn't lever
    // its edge up past the collar it's sewn to.
    cols[o + 6] =
      spheres[i].radius * (ARMS.has(spheres[i].part) ? armScale : 1);
  });
  const h = centerOf(headAt);
  const b = centerOf(bodyAt);
  const hr = spheres[headAt].radius;
  const br = spheres[bodyAt].radius;
  const d = Math.max(1e-6, Math.hypot(b[0] - h[0], b[1] - h[1], b[2] - h[2]));
  // Where the head and torso spheres meet: a circle this wide (or, apart,
  // the smaller of the two).
  const a = (d * d + hr * hr - br * br) / (2 * d);
  const seam =
    Math.abs(a) < hr ? Math.sqrt(hr * hr - a * a) : Math.min(hr, br) * 0.6;
  const o = parts.length * COLLIDER_STRIDE;
  cols[o] = h[0];
  cols[o + 1] = h[1];
  cols[o + 2] = h[2];
  cols[o + 3] = b[0];
  cols[o + 4] = b[1];
  cols[o + 5] = b[2];
  cols[o + 6] = Math.min(seam, br) * 0.97;
  return cols;
}
