import * as THREE from "three";
import {
  merge,
  paint,
  pixelText,
  planked,
  Surface,
} from "../airship/AirshipModel";
import { inSeason, seeThrough } from "../ambient";

/**
 * The Wilds' loot furniture, in the Sky Dock's style (see DockModel): plain
 * boxes, vertex-coloured and planked, so they sit with the docks and the
 * ships at the Town's big pixels and cost a draw call or two each.
 *
 * - The cache: an iron-bound chest, its lid ajar on a glow (LootChest
 *   draws it under its beam, here and as the Tower's Warden's chest).
 * - The Crafting Station's workbench: a bench with a lute half made on it,
 *   tonewood stacked at one end, tools on the board behind and a sign over
 *   it, its name on two lines.
 *
 * Both built in their own frame: on the ground at the origin, the front
 * toward +z.
 */

const WOOD = "#8a5a32";
const WOOD_LIGHT = "#a8743f";
const WOOD_DARK = "#5a3a22";
const IRON = "#2b2d33";
const GOLD = "#e7ad3c";
const CREAM = "#f4ead3";

function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  hex: string,
  surface: Surface = Surface.Plain,
): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex, surface);
}

const wood = () =>
  inSeason(
    planked(
      new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    ),
  );

// --- The cache ----------------------------------------------------------------

/** The chest's body's top: where the lid hinges, at its back edge. */
export const CHEST_TOP = 0.46;
const CHEST_D = 0.58;
/** Where the lid's hinge is, in the chest's frame. */
export const LID_HINGE = new THREE.Vector3(0, CHEST_TOP, -CHEST_D / 2);

/** The chest's body (without its lid). */
export function chestBodyGeometry(): THREE.BufferGeometry {
  return merge([
    box(0.9, CHEST_TOP, CHEST_D, 0, CHEST_TOP / 2, 0, WOOD, Surface.Strakes),
    box(0.96, 0.06, 0.64, 0, 0.03, 0, WOOD_DARK),
    // Iron bands round it, and the lock.
    box(0.08, CHEST_TOP + 0.02, CHEST_D + 0.04, -0.28, CHEST_TOP / 2, 0, IRON),
    box(0.08, CHEST_TOP + 0.02, CHEST_D + 0.04, 0.28, CHEST_TOP / 2, 0, IRON),
    box(0.16, 0.18, 0.04, 0, 0.34, CHEST_D / 2 + 0.01, GOLD),
    box(0.04, 0.07, 0.02, 0, 0.33, CHEST_D / 2 + 0.03, IRON),
  ]);
}

/** The lid, hinged at the origin (its back edge), lying shut along +z. */
export function chestLidGeometry(): THREE.BufferGeometry {
  const mid = CHEST_D / 2 + 0.02;
  return merge([
    box(0.94, 0.12, CHEST_D + 0.04, 0, 0.06, mid, WOOD, Surface.Strakes),
    box(0.86, 0.08, CHEST_D - 0.06, 0, 0.16, mid, WOOD_LIGHT),
    box(0.09, 0.21, CHEST_D + 0.06, -0.28, 0.1, mid, IRON),
    box(0.09, 0.21, CHEST_D + 0.06, 0.28, 0.1, mid, IRON),
    box(0.14, 0.08, 0.03, 0, 0.04, CHEST_D + 0.05, GOLD),
  ]);
}

/** What glows inside, seen through the lid ajar. */
export function chestGlowGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(0.82, 0.02, CHEST_D - 0.08).translate(
    0,
    CHEST_TOP - 0.02,
    0,
  );
}

export const chestMaterial = (): THREE.Material => wood();

// --- The Crafting Station's workbench ----------------------------------------

/** The bench's footprint, half across and half deep (for its collider). */
export const BENCH_HALF = { x: 0.85, z: 0.4 };

export function workbenchGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    // The bench: its top, legs and the shelf under it.
    box(1.7, 0.1, 0.72, 0, 0.78, 0, WOOD_LIGHT, Surface.Across),
    ...[-1, 1].flatMap((sx) =>
      [-1, 1].map((sz) =>
        box(0.1, 0.73, 0.1, sx * 0.76, 0.365, sz * 0.29, WOOD),
      ),
    ),
    box(1.56, 0.06, 0.56, 0, 0.22, 0, WOOD, Surface.Across),
    // The board behind, on two posts, the sign over it: "Crafting Station"
    // on two lines at the pixel a one-word sign had, so it reads as well.
    box(0.1, 2.35, 0.1, -0.8, 1.175, -0.33, WOOD_DARK),
    box(0.1, 2.35, 0.1, 0.8, 1.175, -0.33, WOOD_DARK),
    box(1.5, 0.7, 0.05, 0, 1.3, -0.33, WOOD, Surface.Strakes),
    box(1.6, 0.58, 0.05, 0, 2.02, -0.33, WOOD_DARK),
    pixelText("Crafting", 0.045, 0.02, CREAM).translate(0, 2.155, -0.305),
    pixelText("Station", 0.045, 0.02, CREAM).translate(0, 1.885, -0.305),
    // Tools hung on the board: a saw, a mallet and chisels.
    box(0.38, 0.1, 0.02, -0.4, 1.4, -0.3, "#b8bcc4"),
    box(0.1, 0.12, 0.03, -0.62, 1.4, -0.3, WOOD_DARK),
    box(0.05, 0.3, 0.03, 0.02, 1.32, -0.3, WOOD_LIGHT),
    box(0.14, 0.1, 0.06, 0.02, 1.5, -0.3, WOOD_DARK),
    ...[0.3, 0.4, 0.5].flatMap((x) => [
      box(0.03, 0.12, 0.03, x, 1.46, -0.29, WOOD_DARK),
      box(0.02, 0.12, 0.02, x, 1.34, -0.29, "#b8bcc4"),
    ]),
    // A lute half made, lying on the bench.
    box(0.4, 0.06, 0.34, -0.38, 0.86, 0.08, "#c98a4a"),
    box(0.16, 0.06, 0.24, -0.12, 0.86, 0.08, "#c98a4a"),
    box(0.08, 0.01, 0.08, -0.4, 0.895, 0.08, "#3a2414"),
    box(0.42, 0.04, 0.07, 0.16, 0.86, 0.08, WOOD_DARK),
    box(0.1, 0.05, 0.1, 0.42, 0.86, 0.08, "#3a2414"),
    box(0.78, 0.006, 0.04, -0.02, 0.895, 0.08, "#e8e2d0"),
    // Tonewood stacked at the end.
    box(0.3, 0.05, 0.5, 0.66, 0.855, 0, "#c9a46a"),
    box(0.3, 0.05, 0.5, 0.64, 0.905, 0.02, "#b48a52"),
    box(0.3, 0.05, 0.5, 0.67, 0.955, -0.01, "#c9a46a"),
  ];
  return merge(parts);
}

/** The bench stands tall: dithered where it'd hide the player. */
export const workbenchMaterial = (): THREE.Material => seeThrough(wood());
