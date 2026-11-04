import { mulberry32 } from "@herzies/shared";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { painted } from "./parts";

// Clutter you paint round the buildings in the map editor: barrels, and
// clay pots of flowers. Vertex-coloured, each faces +z.

const WOOD = "#b08a5a";
const WOOD_DARK = "#7a5a3a";
const IRON = "#4a4a50";
const TERRACOTTA = "#c0663a";
const LEAF = "#4f8a3f";

/** A barrel: bellied staves, iron hoops, a lid. */
function barrel(at: [number, number, number] = [0, 0, 0]) {
  const [x, y, z] = at;
  const h = 0.85;
  const staves = new THREE.LatheGeometry(
    [0, 0.25, 0.5, 0.75, 1].map(
      (t) => new THREE.Vector2(0.27 + Math.sin(t * Math.PI) * 0.06, t * h),
    ),
    10,
  );
  return [
    painted(staves.translate(x, y, z), WOOD),
    painted(
      new THREE.CylinderGeometry(0.27, 0.27, 0.02, 10).translate(x, y + h, z),
      WOOD_DARK,
    ),
    ...[0.12, h - 0.12].map((hy) =>
      painted(
        new THREE.CylinderGeometry(0.315, 0.315, 0.05, 10).translate(
          x,
          y + hy,
          z,
        ),
        IRON,
      ),
    ),
  ];
}

/** A clay pot with a leafy plant in it, and a few blossoms. */
function pot(x: number, z: number, s: number, seed: number) {
  const rand = mulberry32(seed);
  const blossom = ["#e86fa8", "#f2d03b", "#f4f1ea", "#9b86f0"][
    Math.floor(rand() * 4)
  ];
  const parts = [
    painted(
      new THREE.CylinderGeometry(0.2 * s, 0.14 * s, 0.32 * s, 8).translate(
        x,
        0.16 * s,
        z,
      ),
      TERRACOTTA,
    ),
    painted(
      new THREE.IcosahedronGeometry(0.22 * s, 1)
        .scale(1, 0.8, 1)
        .translate(x, 0.42 * s, z),
      LEAF,
    ),
  ];
  for (let i = 0; i < 4; i++) {
    const a = rand() * Math.PI * 2;
    parts.push(
      painted(
        new THREE.OctahedronGeometry(0.06 * s, 0).translate(
          x + Math.cos(a) * 0.15 * s,
          (0.5 + rand() * 0.08) * s,
          z + Math.sin(a) * 0.15 * s,
        ),
        blossom,
      ),
    );
  }
  return parts;
}

/** Sized against a stage-3 herzie (about 2.35 tall). */
const SIZE = 1.2;

/** A barrel. */
export function barrelGeometry(): THREE.BufferGeometry {
  return (mergeGeometries(barrel()) as THREE.BufferGeometry).scale(
    SIZE,
    SIZE,
    SIZE,
  );
}

/** Three clay pots of flowers, big to small. */
export function potsGeometry(): THREE.BufferGeometry {
  return (
    mergeGeometries([
      ...pot(-0.25, 0, 1, 3),
      ...pot(0.2, 0.05, 0.8, 8),
      ...pot(0.02, 0.32, 0.65, 13),
    ]) as THREE.BufferGeometry
  ).scale(SIZE, SIZE, SIZE);
}
