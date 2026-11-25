import {
  cellCenter,
  EIGHTH,
  facingAt,
  groundY,
  objectAt,
  type TownMap,
} from "../map";

/**
 * Crafting Stations: where you make any class's Wilds instrument out of
 * that class's own and bits, and tune one with bits. Painted on any map
 * like any other object (CRAFTING_STATION); the Wilds has one in its safe
 * camp by the Sky Dock. Walk up to any of them and press E for the one
 * window (CraftingPanel); the crafting and tuning themselves are the web
 * API's, so where the stations stand is only where the app offers them.
 * The bench itself is CraftingStation.tsx; this is what the app around
 * the Town needs, without three.js.
 */

/** The map char for a Crafting Station ("workbench"). Painted with \ in
 * the editor. */
export const CRAFTING_STATION = "W";

/** Window key, like CRYSTAL_KEY / BULLETIN_KEY. */
export const CRAFTING_KEY = "crafting";

/** How close you need to be for its prompt. */
export const CRAFTING_REACH = 2.4;

/** A Crafting Station: where its bench stands and which way its front (the
 * side you work from) looks. */
export type CraftingSpot = { x: number; y: number; z: number; yaw: number };

/** Which way a station faces: as turned in the editor, else toward the
 * middle of the island, squared to the eight compass points (so a new one
 * is worked at from the island's side, like a bulletin board is read). */
export function craftingFacing(map: TownMap, col: number, row: number): number {
  const turned = facingAt(map, col, row);
  if (turned !== undefined) return turned;
  const [x, z] = cellCenter(map, col, row);
  return Math.round(Math.atan2(-x, -z) / EIGHTH) * EIGHTH;
}

/** Every Crafting Station on the map. */
export function craftingStationsOf(map: TownMap): CraftingSpot[] {
  const out: CraftingSpot[] = [];
  for (let row = 0; row < map.size; row++)
    for (let col = 0; col < map.size; col++) {
      if (objectAt(map, col, row) !== CRAFTING_STATION) continue;
      const [x, z] = cellCenter(map, col, row);
      out.push({
        x,
        y: groundY(map, x, z),
        z,
        yaw: craftingFacing(map, col, row),
      });
    }
  return out;
}

/** Whether (x, z) is within reach of any of `stations`. */
export function craftingNear(
  stations: readonly CraftingSpot[],
  x: number,
  z: number,
): boolean {
  for (const s of stations)
    if (Math.hypot(x - s.x, z - s.z) < CRAFTING_REACH) return true;
  return false;
}
