import { MADAS_KEY } from "@herzies/shared";
import { inWildsSafeCamp } from "@herzies/shared/wilds";
import { outOfCamp, WILDS_CACHE_SPOTS } from "@herzies/shared/wilds-loot";
import { describe, expect, it } from "vitest";
import { berthOf } from "../airship/berth";
import {
  buildingsOf,
  cellAt,
  objectAt,
  petWalkable,
  type TownMap,
  worldRadius,
} from "../map";
import { TOWN_MAPS_LOCAL } from "../maps";
import { CRAFTING_STATION, craftingStationsOf } from "./craftingSpot";
import { HUNT_CRYSTAL, huntCrystalsOf } from "./HuntCrystal";

const wilds = TOWN_MAPS_LOCAL.get("wilds") as TownMap;

/** Nothing stands on the cell at (x, z) (but `self`, what's meant to stand
 * there) or the eight round it, and you can walk there (short of the
 * island's edge, not in water): room for a chest or a bench and for
 * walking up to it. */
function openGround(map: TownMap, x: number, z: number, self = "."): string[] {
  const why: string[] = [];
  const walk = petWalkable(map, worldRadius(map));
  const [col, row] = cellAt(map, x, z);
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      const o = objectAt(map, col + dc, row + dr);
      const own = !dr && !dc && o === self;
      if (o !== "." && o !== " " && !own)
        why.push(`"${o}" at (${col + dc}, ${row + dr})`);
      if (!walk(x + dc, z + dr))
        why.push(`not walkable at ${x + dc}, ${z + dr}`);
    }
  for (const b of buildingsOf(map))
    for (const r of b.rects) {
      const near =
        col >= r.col - 2 &&
        col < r.col + r.w + 2 &&
        row >= r.row - 2 &&
        row < r.row + r.h + 2;
      if (near) why.push(`a ${b.kind} beside it`);
    }
  return why;
}

describe("the Wilds' loot spots", () => {
  it("puts every cache on open ground, well out of the safe camp", () => {
    for (const s of WILDS_CACHE_SPOTS) {
      expect(openGround(wilds, s.x, s.z), `${s.x}, ${s.z}`).toEqual([]);
      expect(inWildsSafeCamp(s.x, s.z)).toBe(false);
      expect(outOfCamp(s.x, s.z)).toBe(true);
    }
  });

  it("puts the Crafting Station on open ground in the camp, off the pier", () => {
    const stations = craftingStationsOf(wilds);
    expect(stations).toHaveLength(1);
    const { x, z } = stations[0];
    expect(openGround(wilds, x, z, CRAFTING_STATION)).toEqual([]);
    expect(inWildsSafeCamp(x, z)).toBe(true);
    // Not in the way of whoever walks up from the ship.
    const b = berthOf(wilds);
    expect(b).not.toBeNull();
    if (b) expect(Math.abs(z - b.pierStart.z)).toBeGreaterThan(3);
  });

  it("stands Madas on open ground in the camp, clear of the station", () => {
    const at = wilds.spots[MADAS_KEY];
    expect(at).toBeDefined();
    if (!at) return;
    const [x, z] = at;
    expect(openGround(wilds, x, z)).toEqual([]);
    expect(inWildsSafeCamp(x, z)).toBe(true);
    for (const s of craftingStationsOf(wilds))
      expect(Math.hypot(s.x - x, s.z - z)).toBeGreaterThan(3);
  });

  it("stands one Hunt Crystal on open ground in the camp", () => {
    const crystals = huntCrystalsOf(wilds);
    expect(crystals).toHaveLength(1);
    const { x, z } = crystals[0];
    expect(openGround(wilds, x, z, HUNT_CRYSTAL)).toEqual([]);
    expect(inWildsSafeCamp(x, z)).toBe(true);
  });
});
