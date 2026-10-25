import { describe, expect, it } from "vitest";
import {
  buildingsOf,
  cellCenter,
  elevation,
  emptyMap,
  groundY,
  hasHills,
  LEVEL_HEIGHT,
  levelAt,
  levelCell,
  objectPlace,
  parseMap,
  RIM_FADE,
  serializeMap,
  type TownMap,
  terrainAt,
  withLevel,
} from "./map";
import { HOME_MAP } from "./runtime";

/** A 40-cell island with a level-4 plateau 6×6 round its middle. */
function hill(): TownMap {
  let map = emptyMap(40, "hill", "Hill");
  for (let r = 17; r < 23; r++)
    for (let c = 17; c < 23; c++) map = withLevel(map, c, r, 4);
  return map;
}

describe("elevation", () => {
  it("leaves flat maps exactly as they were", () => {
    const flat = emptyMap(40, "flat", "Flat");
    expect(hasHills(flat)).toBe(false);
    expect(serializeMap(flat)).not.toContain("heights");
    // Everywhere on a flat map is where it always was: y = 0 — on a
    // bridge too (home's, over the stream), not down in the bed under it.
    const bridge = cellCenter(HOME_MAP, 27, 26);
    expect(terrainAt(HOME_MAP, 27, 26)).toBe("=");
    for (const [x, z] of [[0, 0], [5.3, -7.1], [-12, 3], bridge]) {
      expect(groundY(HOME_MAP, x, z)).toBe(0);
      expect(elevation(flat, x, z)).toBe(0);
    }
  });

  it("paints levels, and saves and reads them back", () => {
    const map = hill();
    expect(levelAt(map, 20, 20)).toBe(4);
    expect(levelAt(map, 10, 20)).toBe(0);
    const back = parseMap(JSON.parse(serializeMap(map)));
    expect(back.heights).toEqual(map.heights);
    expect(serializeMap(back)).toBe(serializeMap(map));
  });

  it("rolls smoothly up to a plateau", () => {
    const map = hill();
    const top = 4 * LEVEL_HEIGHT;
    // The plateau's middle is all the way up; far off, the ground is flat.
    expect(elevation(map, 0, 0)).toBeCloseTo(top);
    expect(elevation(map, 10, 0)).toBe(0);
    // Its edge (x = 3) is halfway, sloping over a unit either side.
    expect(elevation(map, 3, 0)).toBeCloseTo(top / 2);
    expect(elevation(map, 2, 0)).toBeCloseTo(top);
    expect(elevation(map, 4, 0)).toBeCloseTo(0);
    // No steps: small moves make small changes.
    for (let x = -6; x < 6; x += 0.05) {
      expect(
        Math.abs(elevation(map, x + 0.05, 0.3) - elevation(map, x, 0.3)),
      ).toBeLessThan(0.1);
    }
    expect(levelCell(map, 20, 20)).toBe(true);
    expect(levelCell(map, 22, 20)).toBe(false);
  });

  it("sinks back to the rim, so the ground meets the island's side", () => {
    let map = emptyMap(40, "rim", "Rim");
    for (let c = 0; c < 40; c++) map = withLevel(map, c, 20, 9);
    expect(elevation(map, 19.99, 0.5)).toBeCloseTo(0, 1);
    expect(elevation(map, 20 - RIM_FADE - 1, 0.5)).toBeCloseTo(
      9 * LEVEL_HEIGHT * 0.5,
    );
  });

  it("stands things on the ground", () => {
    const map = hill();
    map.objects[20] = `${map.objects[20].slice(0, 20)}T${map.objects[20].slice(21)}`;
    const t = objectPlace(map, 20, 20);
    expect(t.y).toBeCloseTo(groundY(map, t.x, t.z));
    expect(t.y).toBeGreaterThan(1);
  });

  it("puts a building's floor at its highest ground, a plinth to its lowest", () => {
    const map = hill();
    for (const c of [22, 23])
      map.objects[20] = `${map.objects[20].slice(0, c)}H${map.objects[20].slice(c + 1)}`;
    const [b] = buildingsOf(map);
    expect(b.y).toBeCloseTo(4 * LEVEL_HEIGHT);
    expect(b.foot).toBeLessThan(b.y);
  });

  it("turns away levels off the island or out of range", () => {
    const map = hill();
    const json = JSON.parse(serializeMap(map));
    json.heights[0] = `5${json.heights[0].slice(1)}`;
    expect(() => parseMap(json)).toThrow(/heights \(0, 0\): off the island/);
    const bad = JSON.parse(serializeMap(map));
    bad.heights[20] = `${bad.heights[20].slice(0, 20)}x${bad.heights[20].slice(21)}`;
    expect(() => parseMap(bad)).toThrow(/heights \(20, 20\): unknown "x"/);
  });
});
