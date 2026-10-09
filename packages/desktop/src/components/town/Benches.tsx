import { CuboidCollider } from "@react-three/rapier";
import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  cellCenter,
  EIGHTH,
  facingAt,
  MAP_SIZE,
  objectAt,
  type TownMap,
  terrainAt,
} from "./map";

// Park benches: wooden slats on iron ends, two seats each. Press E by one
// to sit (see TownCanvas's Systems), walk off or press E again to stand.

/** The map char for a bench. */
export const BENCH = "_";
/** Where a sitting herzie's feet go: on top of the seat. */
export const SEAT_Y = 0.53;
/** How close to a seat you have to be to sit on it. */
export const SIT_RANGE = 2.4;

const LENGTH = 2.6;
const DEPTH = 0.62;
const BACK_HEIGHT = 1.2;
/** Seats either side of the middle, this far out. */
const SEAT_OFFSET = 0.62;
/** Standing up puts you this far in front of the seat. */
const STAND_OFF = 1.15;
/** Faces the nearest path this close, else the middle of town. */
const PATH_REACH = 7;

/** A seat on a bench: where you sit, which way you face, and where you
 * stand back up. */
export type Seat = {
  x: number;
  z: number;
  heading: number;
  stand: { x: number; z: number };
};
export type Bench = { x: number; z: number; yaw: number; seats: Seat[] };

/** Which way a bench faces: the way it was turned in the editor, else
 * toward the nearest path, or the middle of town; squared to the eight
 * compass points, so it sits neatly. */
export function benchFacing(map: TownMap, col: number, row: number): number {
  const turned = facingAt(map, col, row);
  if (turned !== undefined) return turned;
  const [x, z] = cellCenter(col, row);
  let best = Number.POSITIVE_INFINITY;
  let to: [number, number] = [-x, -z];
  for (let dr = -PATH_REACH; dr <= PATH_REACH; dr++) {
    for (let dc = -PATH_REACH; dc <= PATH_REACH; dc++) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= MAP_SIZE || r >= MAP_SIZE) continue;
      if (terrainAt(map, c, r) !== "g") continue;
      const d = Math.hypot(dc, dr);
      if (d > 0 && d < best) {
        best = d;
        to = [dc, dr];
      }
    }
  }
  const yaw = Math.atan2(to[0], to[1]);
  return Math.round(yaw / EIGHTH) * EIGHTH;
}

/** Every bench on the map, with its seats. */
export function benchesOf(map: TownMap): Bench[] {
  const out: Bench[] = [];
  for (let row = 0; row < MAP_SIZE; row++) {
    for (let col = 0; col < MAP_SIZE; col++) {
      if (objectAt(map, col, row) !== BENCH) continue;
      const [x, z] = cellCenter(col, row);
      const yaw = benchFacing(map, col, row);
      // Forward is (sin, cos); along the bench, at right angles to it.
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const seats = [-1, 1].map((side) => {
        const sx = x + Math.cos(yaw) * SEAT_OFFSET * side + fx * 0.04;
        const sz = z - Math.sin(yaw) * SEAT_OFFSET * side + fz * 0.04;
        return {
          x: sx,
          z: sz,
          heading: yaw,
          stand: { x: sx + fx * STAND_OFF, z: sz + fz * STAND_OFF },
        };
      });
      out.push({ x, z, yaw, seats });
    }
  }
  return out;
}

/** The free seat nearest (x, z) within SIT_RANGE, if any. `taken` says
 * whether someone's sitting there already. */
export function seatNear(
  benches: Bench[],
  x: number,
  z: number,
  taken: (s: Seat) => boolean,
): Seat | null {
  let best: Seat | null = null;
  let bestD = SIT_RANGE;
  for (const b of benches) {
    for (const s of b.seats) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bestD && !taken(s)) {
        best = s;
        bestD = d;
      }
    }
  }
  return best;
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
const IRON = "#2b2d33";

/** One bench, facing +z, its middle at the origin. */
function benchGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number) =>
    new THREE.BoxGeometry(w, h, d);
  // The seat: three slats.
  [-0.2, 0, 0.2].forEach((z, i) => {
    parts.push(
      part(box(LENGTH, 0.06, 0.17).translate(0, SEAT_Y - 0.03, z), WOOD[i]),
    );
  });
  // The back: two slats, leaning back a little.
  [0.78, 1.05].forEach((y, i) => {
    parts.push(
      part(
        box(LENGTH, 0.15, 0.05)
          .rotateX(-0.18)
          .translate(0, y, -0.29 - (y - SEAT_Y) * 0.18),
        WOOD[(i + 1) % 3],
      ),
    );
  });
  // Iron ends: a front leg, a back leg running up to hold the back, an
  // armrest, and a rail under the seat.
  for (const side of [-1, 1]) {
    const x = side * (LENGTH / 2 - 0.16);
    parts.push(
      part(box(0.07, SEAT_Y, 0.07).translate(x, SEAT_Y / 2, 0.24), IRON),
      part(
        box(0.07, BACK_HEIGHT, 0.07)
          .rotateX(-0.18)
          .translate(x, BACK_HEIGHT / 2, -0.33),
        IRON,
      ),
      part(box(0.07, 0.06, DEPTH).translate(x, SEAT_Y - 0.08, -0.02), IRON),
      part(box(0.08, 0.06, 0.62).translate(x, 0.78, -0.02), IRON),
      part(box(0.07, 0.3, 0.07).translate(x, 0.64, 0.24), IRON),
    );
  }
  return mergeGeometries(parts) as THREE.BufferGeometry;
}
const BENCH_GEOMETRY = benchGeometry();

/** Not see-through like the trees: low, a bench never hides the player. */
const benchMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
});

/** Every bench on the map, as one mesh. */
export function Benches({ map }: { map: TownMap }) {
  const geometry = useMemo(() => {
    const benches = benchesOf(map);
    if (benches.length === 0) return null;
    return mergeGeometries(
      benches.map((b) =>
        BENCH_GEOMETRY.clone().rotateY(b.yaw).translate(b.x, 0, b.z),
      ),
    ) as THREE.BufferGeometry;
  }, [map]);
  useLayoutEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return (
    <mesh
      geometry={geometry}
      material={benchMaterial}
      castShadow
      receiveShadow
    />
  );
}

/** A bench is solid (you sit on it, not in it). */
export function BenchColliders({ map }: { map: TownMap }) {
  const benches = useMemo(() => benchesOf(map), [map]);
  return (
    <>
      {benches.map((b) => (
        <CuboidCollider
          key={`bench${b.x},${b.z}`}
          args={[LENGTH / 2, 0.5, DEPTH / 2]}
          position={[b.x, 0.5, b.z]}
          rotation={[0, b.yaw, 0]}
        />
      ))}
    </>
  );
}
