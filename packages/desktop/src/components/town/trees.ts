import { mulberry32 } from "@herzies/shared";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { seeThrough, swayInWind } from "./ambient";
import {
  isBuildingChar,
  MAP_SIZE,
  objectAt,
  type TownMap,
  terrainAt,
} from "./map";

// The town's trees: pines and oaks, a few shapes of each, every
// one leaning, stretched and tinted a little its own way — and which kind
// stands where picked from the map, so they grow in kinds the way trees do.

export const SPECIES = ["pine", "oak"] as const;
export type Species = (typeof SPECIES)[number];

/** Colour a geometry by height: `shade(y, x, z)` per vertex. In the shape
 * mergeGeometries wants: no index, no uvs. */
function shaded(
  g: THREE.BufferGeometry,
  shade: (y: number, x: number, z: number) => THREE.Color,
): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute("uv");
  const pos = out.attributes.position;
  const colors: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const c = shade(pos.getY(i), pos.getX(i), pos.getZ(i));
    colors.push(c.r, c.g, c.b);
  }
  out.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return out;
}

const flat = (hex: string) => {
  const c = new THREE.Color(hex);
  return () => c;
};

/** A branch: a thin cylinder from `from`, leaning out toward `yaw`. */
function branch(
  from: [number, number, number],
  length: number,
  radius: number,
  lean: number,
  yaw: number,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius * 0.6, radius, length, 5);
  g.translate(0, length / 2, 0);
  g.rotateZ(-lean);
  g.rotateY(yaw);
  return g.translate(...from);
}

/** A steady 0–1 for a point: the same wherever the same corner turns up
 * (in each face that shares it), so displacing by it leaves no cracks. */
function hash3(x: number, y: number, z: number): number {
  const k = (v: number) => Math.round(v * 1000);
  return mulberry32(
    Math.imul(k(x), 73856093) ^
      Math.imul(k(y), 19349663) ^
      Math.imul(k(z), 83492791),
  )();
}

/**
 * A leafy crown: a few dark masses inside, and over them many smaller,
 * lumpy clumps of leaves, spread over an ellipsoid and heaped up on top, so
 * the outline is broken and bumpy. Coloured face by face — dark inside and
 * underneath, lit on the outer, sunward side, each face a shade of its own
 * and a few catching the light — so it reads as leaves, not balls.
 */
function leafyCrown(
  rand: () => number,
  centre: [number, number, number],
  radii: [number, number, number],
  palette: { deep: string; mid: string; lit: string; glint: string },
): THREE.BufferGeometry[] {
  const [cx, cy, cz] = centre;
  const [rx, ry, rz] = radii;
  const lumps: [number, number, number, number][] = [];
  // The dark masses inside, holding the shape together.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rand();
    lumps.push([
      cx + Math.cos(a) * rx * 0.35,
      cy + (rand() - 0.4) * ry * 0.5,
      cz + Math.sin(a) * rz * 0.35,
      Math.min(rx, rz) * (0.6 + rand() * 0.15),
    ]);
  }
  // Clumps over the surface, fewer underneath.
  for (let i = 0; i < 22; i++) {
    const a = rand() * Math.PI * 2;
    const up = rand() * 1.5 - 0.5;
    const t = Math.max(-0.55, Math.min(1, up));
    const flat = Math.sqrt(1 - t * t);
    const r = 0.65 + rand() * 0.55;
    const out = 0.8 + rand() * 0.2;
    lumps.push([
      cx + Math.cos(a) * flat * rx * out,
      cy + t * ry * out,
      cz + Math.sin(a) * flat * rz * out,
      r,
    ]);
  }
  const deep = new THREE.Color(palette.deep);
  const mid = new THREE.Color(palette.mid);
  const lit = new THREE.Color(palette.lit);
  const glint = new THREE.Color(palette.glint);
  const sun = new THREE.Vector3(-0.4, 0.8, 0.45).normalize();
  const c = new THREE.Color();
  return lumps.map(([x, y, z, r]) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    // Lumpy: each corner pushed in or out a little.
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i);
      const py = pos.getY(i);
      const pz = pos.getZ(i);
      const k = 0.78 + hash3(px + x, py + y, pz + z) * 0.4;
      pos.setXYZ(i, px * k + x, py * k * 0.88 + y, pz * k + z);
    }
    // Face by face (three corners each, unindexed).
    const colors: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const d = new THREE.Vector3();
    const n = new THREE.Vector3();
    const mid3 = new THREE.Vector3();
    for (let f = 0; f < pos.count; f += 3) {
      a.fromBufferAttribute(pos, f);
      b.fromBufferAttribute(pos, f + 1);
      d.fromBufferAttribute(pos, f + 2);
      mid3.copy(a).add(b).add(d).divideScalar(3);
      n.copy(b).sub(a).cross(d.clone().sub(a)).normalize();
      // How far out of the crown, and how high: the inside and the
      // underside in shadow.
      const ox = (mid3.x - cx) / rx;
      const oy = (mid3.y - cy) / ry;
      const oz = (mid3.z - cz) / rz;
      const outward = Math.min(1, Math.hypot(ox, oy, oz));
      const height = Math.min(1, Math.max(0, oy * 0.5 + 0.5));
      const light = Math.max(0, n.dot(sun));
      let t = outward * 0.55 + height * 0.3 + light * 0.25;
      t += (hash3(mid3.x, mid3.y, mid3.z) - 0.5) * 0.22;
      t = Math.min(1, Math.max(0, t));
      if (t < 0.5) c.lerpColors(deep, mid, t / 0.5);
      else c.lerpColors(mid, lit, (t - 0.5) / 0.5);
      // Now and then a face on the sunny side catches the light.
      if (light > 0.55 && outward > 0.8 && hash3(mid3.z, mid3.x, 7) < 0.14) {
        c.lerp(glint, 0.7);
      }
      for (let v = 0; v < 3; v++) colors.push(c.r, c.g, c.b);
    }
    g.deleteAttribute("uv");
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return g;
  });
}

/** A pine: a stack of tiers, each dark at its rim and lit higher up, so
 * every tier — and every tree beside it — stands out from the next. */
function pine(seed: number): THREE.BufferGeometry {
  const rand = mulberry32(seed);
  const parts = [
    shaded(
      new THREE.CylinderGeometry(0.22, 0.34, 3.6, 6).translate(0, 1.8, 0),
      flat("#5a4030"),
    ),
  ];
  const tiers = 4;
  let base = 2.3 + rand() * 0.3;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const radius = (2.1 - t * 1.25) * (0.92 + rand() * 0.16);
    const height = 3.3 - t * 0.9;
    const dx = (rand() - 0.5) * 0.16;
    const dz = (rand() - 0.5) * 0.16;
    const turn = rand() * Math.PI;
    const shade = (() => {
      const rim = new THREE.Color("#1d4529");
      const lit = new THREE.Color(i % 2 === 0 ? "#3f7a45" : "#3a7442");
      const tip = new THREE.Color("#2f6338");
      const c = new THREE.Color();
      return (y: number) => {
        const f = (y - base) / height;
        return f < 0.45
          ? c.lerpColors(rim, lit, f / 0.45)
          : c.lerpColors(lit, tip, (f - 0.45) / 0.55);
      };
    })();
    const cone = new THREE.ConeGeometry(radius, height, 7, 1, true)
      .rotateY(turn)
      .translate(dx, base + height / 2, dz);
    parts.push(shaded(cone, shade));
    // Closed underneath, in shadow.
    const under = new THREE.CircleGeometry(radius, 7)
      .rotateX(Math.PI / 2)
      .rotateY(turn)
      .translate(dx, base + 0.02, dz);
    parts.push(shaded(under, flat("#163a22")));
    // The next tier starts a little over halfway up this one.
    base += height * (0.5 + rand() * 0.06);
  }
  return mergeGeometries(parts) as THREE.BufferGeometry;
}

/** An oak: a thick, short trunk forking into heavy branches, under a
 * broad, lumpy crown. */
function oak(seed: number): THREE.BufferGeometry {
  const rand = mulberry32(seed);
  const bark = flat("#4e3828");
  const yaw = rand() * Math.PI * 2;
  const parts = [
    shaded(
      new THREE.CylinderGeometry(0.38, 0.6, 3.6, 7).translate(0, 1.8, 0),
      bark,
    ),
    shaded(branch([0, 3.1, 0], 2.2, 0.3, 0.6, yaw), bark),
    shaded(branch([0, 3.3, 0], 2.0, 0.26, 0.55, yaw + 2.4), bark),
    shaded(branch([0, 3.4, 0], 1.7, 0.2, 0.75, yaw + 4.3), bark),
    shaded(branch([0, 3.6, 0], 1.6, 0.16, 0.35, yaw + 1.2), bark),
    ...leafyCrown(
      rand,
      [(rand() - 0.5) * 0.4, 6.0 + rand() * 0.4, (rand() - 0.5) * 0.4],
      [2.5 + rand() * 0.3, 1.75, 2.4 + rand() * 0.3],
      { deep: "#1a3418", mid: "#3a6a2c", lit: "#6e9e44", glint: "#a8c860" },
    ),
  ];
  return mergeGeometries(parts) as THREE.BufferGeometry;
}

/** A few shapes of each kind, so neighbours differ. */
export const TREE_VARIANTS: Record<Species, THREE.BufferGeometry[]> = {
  pine: [11, 23, 37].map(pine),
  oak: [3, 19].map(oak),
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
      if (c < 0 || r < 0 || c >= MAP_SIZE || r >= MAP_SIZE) continue;
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
