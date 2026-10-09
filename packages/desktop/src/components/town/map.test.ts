import { describe, expect, it } from "vitest";
import {
  BRIDGE_CLEARANCE,
  bridgeAxis,
  buildingsOf,
  cellAt,
  cellCenter,
  emptyMap,
  inland,
  MAP_SIZE,
  OFF,
  onIsland,
  parseMap,
  SPOT_NAMES,
  serializeMap,
  type TownMap,
  waterRuns,
} from "./map";
import homeMap from "./maps/home.json";

const MID = MAP_SIZE / 2;

/** Paint `ch` into a layer at (col, row). */
function paint(
  map: TownMap,
  layer: "terrain" | "objects",
  col: number,
  row: number,
  ch: string,
) {
  const r = map[layer][row];
  map[layer][row] = r.slice(0, col) + ch + r.slice(col + 1);
}

describe("town map", () => {
  it("parses the committed home island", () => {
    const map = parseMap(homeMap);
    // It's painted by hand, so only check what the game relies on.
    for (const kind of Object.keys(SPOT_NAMES)) {
      expect(map.spots[kind]).toHaveLength(2);
    }
    expect(map.spare.length).toBeGreaterThan(0);
  });

  it("round-trips through its file format", () => {
    const map = emptyMap();
    paint(map, "terrain", MID, MID, "~");
    paint(map, "objects", MID + 3, MID, "R");
    map.spots = { merchant: [-8, -1] };
    const back = parseMap(JSON.parse(serializeMap(map)));
    expect(back).toEqual(map);
  });

  it("maps cells to the world and back", () => {
    expect(cellCenter(MID, MID)).toEqual([0.5, 0.5]);
    expect(cellAt(0.5, 0.5)).toEqual([MID, MID]);
    expect(cellAt(-0.1, -0.1)).toEqual([MID - 1, MID - 1]);
    expect(onIsland(0, 0)).toBe(false);
    expect(onIsland(0, MID)).toBe(true);
    // The western rim cell is partly over the edge: on the island, but not
    // inland.
    expect(inland(0, MID)).toBe(false);
    expect(inland(MID, MID)).toBe(true);
  });

  it("rejects broken maps", () => {
    const bad = emptyMap();
    paint(bad, "terrain", MID, MID, "x");
    expect(() => parseMap(bad)).toThrow(/unknown "x"/);

    const offIsland = emptyMap();
    paint(offIsland, "objects", 0, 0, "T");
    expect(() => parseMap(offIsland)).toThrow(/off the island/);

    const rim = emptyMap();
    paint(rim, "terrain", 0, MID, "~");
    expect(() => parseMap(rim)).toThrow(/water on the rim/);

    const wetTree = emptyMap();
    paint(wetTree, "terrain", MID, MID, "~");
    paint(wetTree, "objects", MID, MID, "T");
    expect(() => parseMap(wetTree)).toThrow(/standing in water/);

    const far = emptyMap();
    far.spawn.at = [41, 0];
    expect(() => parseMap(far)).toThrow(/past the edge/);

    const short = emptyMap();
    short.terrain = short.terrain.slice(1);
    expect(() => parseMap(short)).toThrow(/expected 86 rows/);
  });

  it("merges open water into runs, leaving bridges open", () => {
    const map = emptyMap();
    for (let c = MID - 3; c < MID + 3; c++) paint(map, "terrain", c, MID, "~");
    paint(map, "terrain", MID, MID, "=");
    paint(map, "terrain", MID, MID + 1, "~");
    const B = BRIDGE_CLEARANCE;
    expect(waterRuns(map)).toEqual([
      // West of the bridge, stood back from it…
      { x0: -3, x1: -B, z0: 0, z1: 1 },
      // …and east of it.
      { x0: 1 + B, x1: 3, z0: 0, z1: 1 },
      // South of it, stood back on its north side.
      { x0: 0, x1: 1, z0: 1 + B, z1: 2 },
    ]);
  });

  it("crosses a bridge across the water it spans", () => {
    // A north–south stream, bridged east–west.
    const map = emptyMap();
    for (let r = MID - 3; r <= MID + 3; r++) paint(map, "terrain", MID, r, "~");
    paint(map, "terrain", MID, MID, "=");
    expect(bridgeAxis(map, MID, MID)).toBe("x");

    // An east–west stream, bridged north–south.
    const other = emptyMap();
    for (let c = MID - 3; c <= MID + 3; c++)
      paint(other, "terrain", c, MID, "~");
    paint(other, "terrain", MID, MID, "=");
    expect(bridgeAxis(other, MID, MID)).toBe("z");
  });

  it("marks off-island cells with spaces", () => {
    const map = emptyMap();
    expect(map.terrain[0][0]).toBe(OFF);
    expect(map.terrain[MID][MID]).toBe(".");
  });

  it("builds one house per patch, split into rectangles", () => {
    const map = emptyMap();
    // An L: a 3×2 block with a 1×2 wing below its west end…
    for (let r = 10; r < 12; r++) {
      for (let c = 20; c < 23; c++) paint(map, "objects", c, r, "H");
    }
    paint(map, "objects", 20, 12, "H");
    paint(map, "objects", 20, 13, "H");
    // …and a separate hut.
    paint(map, "objects", 60, 60, "H");

    const [l, hut] = buildingsOf(map);
    expect(l.rects).toEqual([
      { col: 20, row: 10, w: 3, h: 2 },
      { col: 20, row: 12, w: 1, h: 2 },
    ]);
    expect(hut.rects).toEqual([{ col: 60, row: 60, w: 1, h: 1 }]);
    // The L is north-west of town: its door faces south-east, and the
    // south side's middle is open ground (the wing is on the west end).
    expect(l.door?.side).toBe("s");
    // The hut is south-east: its door faces north or west.
    expect(["n", "w"]).toContain(hut.door?.side);
  });

  it("parses the new things", () => {
    const map = emptyMap();
    for (const [i, ch] of ["v", "*", "m", "H", "$", "C", "@", "B"].entries()) {
      paint(map, "objects", MID + i * 2, MID, ch);
    }
    expect(() => parseMap(map)).not.toThrow();
  });
});
