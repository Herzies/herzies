import { cellCenter, groundY, objectAt, type TownMap } from "../map";

/**
 * Hunt Crystals: the Wilds' meter for its next cache (see HuntCrystal.tsx
 * for the thing itself). Painted on a map like any object (HUNT_CRYSTAL);
 * the Wilds has one in its safe camp. Walk up to one and press E to talk to
 * it (HuntCrystalPanel). This is what the app around the Town needs,
 * without three.js.
 */

/** The map char for a Hunt Crystal ("gold"). Painted with ` in the
 * editor. */
export const HUNT_CRYSTAL = "G";

/** Window key, like CRAFTING_KEY. */
export const HUNT_CRYSTAL_KEY = "hunt-crystal";

/** How close you need to be to talk to it (its cradle's a little wider
 * than a bench). */
export const HUNT_CRYSTAL_REACH = 2.8;

export type HuntCrystalSpot = { x: number; y: number; z: number };

/** Every Hunt Crystal on the map. */
export function huntCrystalsOf(map: TownMap): HuntCrystalSpot[] {
  const out: HuntCrystalSpot[] = [];
  for (let row = 0; row < map.size; row++)
    for (let col = 0; col < map.size; col++) {
      if (objectAt(map, col, row) !== HUNT_CRYSTAL) continue;
      const [x, z] = cellCenter(map, col, row);
      out.push({ x, y: groundY(map, x, z), z });
    }
  return out;
}

/** Whether (x, z) is within talking reach of any of `crystals`. */
export function huntCrystalNear(
  crystals: readonly HuntCrystalSpot[],
  x: number,
  z: number,
): boolean {
  for (const c of crystals)
    if (Math.hypot(x - c.x, z - c.z) < HUNT_CRYSTAL_REACH) return true;
  return false;
}
