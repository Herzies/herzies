import { CuboidCollider } from "@react-three/rapier";
import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  cellCenter,
  EIGHTH,
  facingAt,
  groundY,
  objectAt,
  type TownMap,
} from "./map";

// Market stands: a wooden counter under a striped awning on four posts,
// with a few wares out on top. Scenery to dress the town (nobody minds
// them yet); solid, like a bench.

/** The map char for a stand ("market"). Not K: that's the shop's key in
 * the editor. */
export const STAND = "M";

const WIDTH = 2.4;
const DEPTH = 1.1;
const COUNTER_HEIGHT = 0.95;
const POST_HEIGHT = 2.3;

/** A stand: where it stands and which way its counter faces. */
export type Stand = {
  x: number;
  /** The ground it stands on. */
  y: number;
  z: number;
  yaw: number;
};

/** Which way a stand faces: as turned in the editor, else toward the middle
 * of town, squared to the eight compass points. */
export function standFacing(map: TownMap, col: number, row: number): number {
  const turned = facingAt(map, col, row);
  if (turned !== undefined) return turned;
  const [x, z] = cellCenter(map, col, row);
  return Math.round(Math.atan2(-x, -z) / EIGHTH) * EIGHTH;
}

/** Every stand on the map. */
export function standsOf(map: TownMap): Stand[] {
  const out: Stand[] = [];
  for (let row = 0; row < map.size; row++)
    for (let col = 0; col < map.size; col++) {
      if (objectAt(map, col, row) !== STAND) continue;
      const [x, z] = cellCenter(map, col, row);
      out.push({
        x,
        y: groundY(map, x, z),
        z,
        yaw: standFacing(map, col, row),
      });
    }
  return out;
}

/** Paint a part one colour, for merging. */
function part(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute("uv");
  const c = new THREE.Color(color);
  out.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(
      Array.from(
        { length: out.attributes.position.count * 3 },
        (_, i) => [c.r, c.g, c.b][i % 3],
      ),
      3,
    ),
  );
  return out;
}

const WOOD = ["#a8743f", "#9a6a3a", "#b07c46"];
const DARK_WOOD = "#6e4a2a";
const AWNING = ["#e8667f", "#f6eee2"];
const WARES = ["#f2b134", "#7fc96b", "#e8667f", "#6fb6e8", "#c98cf2"];

/** One stand, its counter facing +z, its middle at the origin. */
function standGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number) =>
    new THREE.BoxGeometry(w, h, d);
  const front = DEPTH / 2;
  // The counter: a box of planks, a top that overhangs at the front.
  [0, 1, 2].forEach((i) => {
    const h = (COUNTER_HEIGHT - 0.06) / 3;
    parts.push(
      part(
        box(WIDTH, h - 0.02, DEPTH * 0.7).translate(
          0,
          h * i + h / 2,
          front - DEPTH * 0.35,
        ),
        WOOD[i],
      ),
    );
  });
  parts.push(
    part(
      box(WIDTH + 0.1, 0.06, DEPTH * 0.82).translate(
        0,
        COUNTER_HEIGHT - 0.03,
        front - DEPTH * 0.35 + 0.06,
      ),
      DARK_WOOD,
    ),
  );
  // Posts at the corners, the back pair taller so the awning slopes
  // toward the customer.
  for (const sx of [-1, 1])
    for (const [z, h] of [
      [front - 0.05, POST_HEIGHT],
      [-front + 0.05, POST_HEIGHT + 0.3],
    ] as const)
      parts.push(
        part(
          box(0.09, h, 0.09).translate(sx * (WIDTH / 2 - 0.05), h / 2, z),
          DARK_WOOD,
        ),
      );
  // The awning: stripes running front to back, tilted down toward the
  // front, with a scalloped-looking valance of alternating drops.
  const stripes = 8;
  const sw = (WIDTH + 0.3) / stripes;
  const slope = Math.atan2(0.3, DEPTH);
  const mid = POST_HEIGHT + 0.15 + 0.04;
  for (let i = 0; i < stripes; i++) {
    const x = -(WIDTH + 0.3) / 2 + sw * (i + 0.5);
    parts.push(
      part(
        box(sw, 0.05, DEPTH + 0.35)
          .rotateX(slope)
          .translate(x, mid, 0),
        AWNING[i % 2],
      ),
      part(
        box(sw, 0.22, 0.04).translate(
          x,
          POST_HEIGHT - 0.1 - (i % 2) * 0.04,
          front + 0.17,
        ),
        AWNING[i % 2],
      ),
    );
  }
  // Wares on the counter: crates and round things.
  const top = COUNTER_HEIGHT;
  [-0.85, -0.3, 0.25, 0.8].forEach((x, i) => {
    parts.push(
      part(
        box(0.4, 0.16, 0.32).translate(x, top + 0.08, front - 0.3),
        DARK_WOOD,
      ),
    );
    for (const dx of [-0.1, 0.1])
      parts.push(
        part(
          new THREE.IcosahedronGeometry(0.09, 0).translate(
            x + dx,
            top + 0.22,
            front - 0.3,
          ),
          WARES[(i + (dx > 0 ? 1 : 0)) % WARES.length],
        ),
      );
  });
  return mergeGeometries(parts) as THREE.BufferGeometry;
}
const STAND_GEOMETRY = standGeometry();

const standMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
});

/** Every stand on the map, as one mesh. */
export function Stands({ map }: { map: TownMap }) {
  const geometry = useMemo(() => {
    const stands = standsOf(map);
    if (stands.length === 0) return null;
    return mergeGeometries(
      stands.map((s) =>
        STAND_GEOMETRY.clone().rotateY(s.yaw).translate(s.x, s.y, s.z),
      ),
    ) as THREE.BufferGeometry;
  }, [map]);
  useLayoutEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return (
    <mesh
      geometry={geometry}
      material={standMaterial}
      castShadow
      receiveShadow
    />
  );
}

/** A stand is solid: walk round it, not through it. */
export function StandColliders({ map }: { map: TownMap }) {
  const stands = useMemo(() => standsOf(map), [map]);
  return (
    <>
      {stands.map((s) => (
        <CuboidCollider
          key={`stand${s.x},${s.z}`}
          args={[WIDTH / 2, 1, DEPTH / 2]}
          position={[s.x, s.y + 1, s.z]}
          rotation={[0, s.yaw, 0]}
        />
      ))}
    </>
  );
}
