import {
  cellCenter,
  facingAt,
  groundY,
  islandRadius,
  type MapId,
  objectAt,
  type TownMap,
  worldRadius,
} from "../map";
import { GANGWAY, RAIL_THICKNESS } from "./deck";

/**
 * A Sky Dock and the berth beside it. The dock (an `X` on the map) is a
 * pier running out from its cell to as far as anyone can walk; past that,
 * over the island's rim, the ship lies moored broadside, its gangway
 * facing the pier's end and a gangplank between them.
 *
 * Everything here is in the island's own frame (its middle at the origin,
 * its grass at y = 0); `origin` puts it in the sky.
 */

/** The dock's char on the map. */
export const DOCK = "X";
/** How far short of the walkable edge the pier's end stands (so a herzie
 * standing at it isn't pressed against the edge), world units. */
const PIER_END_INSET = 0.4;
/** How far behind the dock's cell the pier begins: its landward step. */
const PIER_BACK = 1.6;
/** How far past the island's rock the hull keeps. */
const HULL_CLEARANCE = 1.0;
/** How high the deck rides over the ground at the dock, moored. */
export const DECK_Y = 1.3;
/** The pier's width. */
export const PIER_WIDTH = 3;

export type Berth = {
  /** The island it's on. */
  map: MapId;
  /** Which way is out of the island, from the dock (forward is (sin,
   * cos)): the pier runs this way. */
  out: number;
  /** Where the pier starts (inland) and ends (the foot of the gangplank),
   * on the ground. */
  pierStart: { x: number; y: number; z: number };
  pierEnd: { x: number; y: number; z: number };
  /** The moored ship: where its deck's origin is and which way its bow
   * points. Its gangway (+x) faces the pier. */
  ship: { x: number; y: number; z: number; yaw: number };
};

/** How far along `out` from (x, z) until `r` from the island's middle. */
function reachAlong(x: number, z: number, out: number, r: number): number {
  const dx = Math.sin(out);
  const dz = Math.cos(out);
  // |p + t·d| = r, the root ahead.
  const b = x * dx + z * dz;
  const c = x * x + z * z - r * r;
  return -b + Math.sqrt(Math.max(0, b * b - c));
}

/** The dock on `map` and the berth beside it; null if it has none. */
export function berthOf(map: TownMap): Berth | null {
  for (let row = 0; row < map.size; row++) {
    for (let col = 0; col < map.size; col++) {
      if (objectAt(map, col, row) !== DOCK) continue;
      const [cx, cz] = cellCenter(map, col, row);
      // Out of the island, unless it was turned by hand.
      const out = facingAt(map, col, row) ?? Math.atan2(cx, cz);
      const dx = Math.sin(out);
      const dz = Math.cos(out);
      const end = reachAlong(cx, cz, out, worldRadius(map) - PIER_END_INSET);
      const hull = reachAlong(cx, cz, out, islandRadius(map) + HULL_CLEARANCE);
      const centre = hull + GANGWAY.x + RAIL_THICKNESS;
      const ground = groundY(map, cx, cz);
      const [ex, ez] = [cx + dx * end, cz + dz * end];
      const [sx, sz] = [cx - dx * PIER_BACK, cz - dz * PIER_BACK];
      return {
        map: map.id,
        out,
        pierStart: { x: sx, y: groundY(map, sx, sz), z: sz },
        pierEnd: { x: ex, y: groundY(map, ex, ez), z: ez },
        ship: {
          x: cx + dx * centre,
          y: ground + DECK_Y,
          z: cz + dz * centre,
          // Its +x (the gangway) faces back along -out: three's rotateY
          // takes +x to (cos yaw, -sin yaw), which is -(sin out, cos out)
          // at yaw = out + π/2.
          yaw: out + Math.PI / 2,
        },
      };
    }
  }
  return null;
}
