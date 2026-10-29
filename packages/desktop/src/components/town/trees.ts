import { mulberry32 } from "@herzies/shared";
import { oakGeometry, pineGeometry } from "@herzies/shared/gl";
import * as THREE from "three";
import { seeThrough, swayInWind } from "./ambient";
import { isBuildingChar, objectAt, type TownMap, terrainAt } from "./map";

// The town's trees: pines and oaks, a few shapes of each, every
// one leaning, stretched and tinted a little its own way — and which kind
// stands where picked from the map, so they grow in kinds the way trees do.

export const SPECIES = ["pine", "oak"] as const;
export type Species = (typeof SPECIES)[number];

/** A few shapes of each kind, so neighbours differ. */
export const TREE_VARIANTS: Record<Species, THREE.BufferGeometry[]> = {
  pine: [11, 23, 37].map(pineGeometry),
  oak: [3, 19].map(oakGeometry),
};
for (const variants of Object.values(TREE_VARIANTS)) {
  for (const g of variants) g.computeVertexNormals();
}

/** The crowns sway above the trunk (see ambient.ts), and go see-through
 * when between the camera and the player; the oaks' leaves flutter too. */
const swaying = (flutter: number) =>
  seeThrough(
    swayInWind(
      new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      { amount: 0.035, from: 2.8, flutter },
    ),
  );
export const TREE_MATERIALS: Record<Species, THREE.Material> = {
  pine: swaying(0),
  oak: swaying(0.05),
};

/** How wide a tree of each kind blocks the way (times its scale). */
export const TREE_RADIUS: Record<Species, number> = {
  pine: 0.45,
  oak: 0.6,
};

/** Smooth noise over the cells, `size` cells across, 0 to 1. */
function noise(col: number, row: number, size: number, seed: number): number {
  const at = (c: number, r: number) =>
    mulberry32(Math.imul(c, 73856093) ^ Math.imul(r, 19349663) ^ seed)();
  const x = col / size;
  const y = row / size;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const ease = (t: number) => t * t * (3 - 2 * t);
  const fx = ease(x - x0);
  const fy = ease(y - y0);
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
  const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
  return top + (bottom - top) * fy;
}

/** 1 right beside the nearest cell that `is`, falling to 0 `reach` cells
 * away (and beyond). */
function closeness(
  map: TownMap,
  col: number,
  row: number,
  reach: number,
  is: (c: number, r: number) => boolean,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let dr = -reach; dr <= reach; dr++) {
    for (let dc = -reach; dc <= reach; dc++) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= map.size || r >= map.size) continue;
      if (is(c, r)) best = Math.min(best, Math.hypot(dc, dr));
    }
  }
  return Math.max(0, 1 - (best - 1) / reach);
}

/**
 * Which kind of tree stands on a tree cell. Pines in clumps, oaks out in
 * the open by the town; and on top of that, a
 * slow drift across the island so whole stretches lean one way — groves,
 * not a scatter. The same every time.
 */
export function treeSpecies(map: TownMap, col: number, row: number): Species {
  let trees = 0;
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      if ((dr || dc) && objectAt(map, col + dc, row + dr) === "T") trees++;
    }
  }
  const density = Math.min(1, trees / 4);
  const town = closeness(
    map,
    col,
    row,
    5,
    (c, r) =>
      terrainAt(map, c, r) === "g" || isBuildingChar(objectAt(map, c, r)),
  );
  const drift = noise(col, row, 9, 0x51ed);
  const jitter = mulberry32(col * 92821 + row * 68917 + 7)();
  const scores: Record<Species, number> = {
    pine: 0.9 * density + 0.7 * drift + 0.15 * jitter,
    oak: 0.9 * town + 0.3 * (1 - density) + 0.45 * (1 - drift),
  };
  return SPECIES.reduce((a, b) => (scores[b] > scores[a] ? b : a));
}

/** How one tree differs from the next of its kind: its shape, how much
 * taller, its lean, and a tint. Steady per cell. */
export function treeLook(col: number, row: number, species: Species) {
  const rand = mulberry32(col * 15485863 + row * 32452843 + 99);
  const variant = Math.floor(rand() * TREE_VARIANTS[species].length);
  const tall = 0.85 + rand() * 0.35;
  const lean = rand() * 0.07;
  const way = rand() * Math.PI * 2;
  const tint = new THREE.Color(1, 1, 1).offsetHSL(
    (rand() - 0.5) * 0.04,
    0,
    (rand() - 0.5) * 0.14,
  );
  return {
    variant,
    tall,
    tilt: [Math.cos(way) * lean, Math.sin(way) * lean] as [number, number],
    tint,
  };
}
