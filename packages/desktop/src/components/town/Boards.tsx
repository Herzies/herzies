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

// Bulletin boards: a plank board on two posts under a little roof, papers
// pinned all over it. Walk up and press E to read what's on this week.

/** The map char for a bulletin board ("notice"). Painted with I in the
 * editor. */
export const BOARD = "N";

/** What `onOpen` is called with when a board is read. */
export const BULLETIN_KEY = "bulletin";

const WIDTH = 1.9;
const POST_HEIGHT = 2.2;
const BOARD_BOTTOM = 0.85;
const BOARD_TOP = 2.0;

/** A board: where it stands and which way its face looks. */
export type Board = {
  x: number;
  /** The ground it stands on. */
  y: number;
  z: number;
  yaw: number;
};

/** Which way a board faces: as turned in the editor, else toward the middle
 * of the island, squared to the eight compass points. */
export function boardFacing(map: TownMap, col: number, row: number): number {
  const turned = facingAt(map, col, row);
  if (turned !== undefined) return turned;
  const [x, z] = cellCenter(map, col, row);
  return Math.round(Math.atan2(-x, -z) / EIGHTH) * EIGHTH;
}

/** Every board on the map. */
export function boardsOf(map: TownMap): Board[] {
  const out: Board[] = [];
  for (let row = 0; row < map.size; row++)
    for (let col = 0; col < map.size; col++) {
      if (objectAt(map, col, row) !== BOARD) continue;
      const [x, z] = cellCenter(map, col, row);
      out.push({
        x,
        y: groundY(map, x, z),
        z,
        yaw: boardFacing(map, col, row),
      });
    }
  return out;
}

/** How close you need to be to read one. */
export const BOARD_REACH = 2.6;

/** The board within reach, nearest first (null: none). */
export function boardNear(
  boards: readonly Board[],
  x: number,
  z: number,
): Board | null {
  let best: Board | null = null;
  let reach = BOARD_REACH;
  for (const b of boards) {
    const d = Math.hypot(x - b.x, z - b.z);
    if (d < reach) {
      reach = d;
      best = b;
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

const WOOD = ["#a8743f", "#9a6a3a", "#b07c46", "#a06e3c"];
const DARK_WOOD = "#6e4a2a";
const ROOF = "#7a3b2e";
const PAPERS = ["#f6eee2", "#f2e3b8", "#e8f0f6", "#f6dce2", "#e6f2d8"];
const PINS = ["#e8667f", "#6fb6e8", "#f2b134", "#7fc96b"];

/** One board, its face looking +z, its middle at the origin. */
function boardGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number) =>
    new THREE.BoxGeometry(w, h, d);
  // Two posts, a little proud of the board's ends.
  for (const sx of [-1, 1])
    parts.push(
      part(
        box(0.12, POST_HEIGHT, 0.12).translate(
          sx * (WIDTH / 2 + 0.02),
          POST_HEIGHT / 2,
          0,
        ),
        DARK_WOOD,
      ),
    );
  // The board: four planks stacked, edge to edge.
  const planks = 4;
  const ph = (BOARD_TOP - BOARD_BOTTOM) / planks;
  for (let i = 0; i < planks; i++)
    parts.push(
      part(
        box(WIDTH, ph - 0.015, 0.07).translate(
          0,
          BOARD_BOTTOM + ph * (i + 0.5),
          0,
        ),
        WOOD[i % WOOD.length],
      ),
    );
  // A frame round the edge.
  parts.push(
    part(
      box(WIDTH + 0.08, 0.06, 0.1).translate(0, BOARD_TOP + 0.03, 0),
      DARK_WOOD,
    ),
    part(
      box(WIDTH + 0.08, 0.06, 0.1).translate(0, BOARD_BOTTOM - 0.03, 0),
      DARK_WOOD,
    ),
  );
  // A small pitched roof over it.
  for (const s of [-1, 1])
    parts.push(
      part(
        box(WIDTH + 0.5, 0.05, 0.42)
          .rotateX(s * 0.5)
          .translate(0, POST_HEIGHT + 0.08, s * 0.18),
        ROOF,
      ),
    );
  // Papers pinned up, a little askew, each with a pin.
  const papers: [x: number, y: number, w: number, h: number, tilt: number][] = [
    [-0.6, 1.62, 0.42, 0.5, 0.06],
    [-0.05, 1.7, 0.36, 0.36, -0.08],
    [0.5, 1.58, 0.44, 0.56, 0.04],
    [-0.42, 1.12, 0.5, 0.36, -0.05],
    [0.18, 1.14, 0.34, 0.42, 0.1],
    [0.66, 1.1, 0.26, 0.3, -0.12],
  ];
  papers.forEach(([x, y, w, h, tilt], i) => {
    parts.push(
      part(
        box(w, h, 0.01)
          .rotateZ(tilt)
          .translate(x, y, 0.045 + i * 0.001),
        PAPERS[i % PAPERS.length],
      ),
      part(
        new THREE.SphereGeometry(0.025, 6, 4).translate(
          x - Math.sin(tilt) * (h / 2 - 0.05),
          y + h / 2 - 0.05,
          0.06,
        ),
        PINS[i % PINS.length],
      ),
    );
    // A few "lines of writing" on each.
    for (let l = 0; l < 3; l++)
      parts.push(
        part(
          box(w * 0.6, 0.02, 0.005)
            .translate(0, h / 4 - l * 0.08, 0)
            .rotateZ(tilt)
            .translate(x, y, 0.053 + i * 0.001),
          "#8a8070",
        ),
      );
  });
  return mergeGeometries(parts) as THREE.BufferGeometry;
}
const BOARD_GEOMETRY = boardGeometry();

const boardMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
});

/** Every board on the map, as one mesh. */
export function Boards({ map }: { map: TownMap }) {
  const geometry = useMemo(() => {
    const boards = boardsOf(map);
    if (boards.length === 0) return null;
    return mergeGeometries(
      boards.map((b) =>
        BOARD_GEOMETRY.clone().rotateY(b.yaw).translate(b.x, b.y, b.z),
      ),
    ) as THREE.BufferGeometry;
  }, [map]);
  useLayoutEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return (
    <mesh
      geometry={geometry}
      material={boardMaterial}
      castShadow
      receiveShadow
    />
  );
}

/** A board is solid: you read it from the front, not walk through it. */
export function BoardColliders({ map }: { map: TownMap }) {
  const boards = useMemo(() => boardsOf(map), [map]);
  return (
    <>
      {boards.map((b) => (
        <CuboidCollider
          key={`board${b.x},${b.z}`}
          args={[WIDTH / 2 + 0.08, 1, 0.15]}
          position={[b.x, b.y + 1, b.z]}
          rotation={[0, b.yaw, 0]}
        />
      ))}
    </>
  );
}
