import { describe, expect, it } from "vitest";
import { chimneysOf, windowLightsOf } from "./Buildings";
import { emptyMap, MAP_SIZE, type TownMap } from "./map";

const MID = MAP_SIZE / 2;

function paintHome(map: TownMap, col: number, row: number) {
  for (let r = row; r < row + 3; r++) {
    const line = map.objects[r];
    map.objects[r] = `${line.slice(0, col)}HHH${line.slice(col + 3)}`;
  }
}

describe("chimneys", () => {
  it("puts smoke on top of the homes that have a chimney", () => {
    const map = emptyMap();
    for (let i = 0; i < 8; i++) paintHome(map, MID - 20 + i * 5, MID);
    const chimneys = chimneysOf(map);
    // Most homes this size have one (about two in three), not all.
    expect(chimneys.length).toBeGreaterThan(2);
    expect(chimneys.length).toBeLessThan(8);
    for (const [x, y, z] of chimneys) {
      // Above the walls, over the row of homes.
      expect(y).toBeGreaterThan(4.6);
      expect(z).toBeGreaterThan(0);
      expect(z).toBeLessThan(3);
      expect(x).toBeGreaterThan(-20);
      expect(x).toBeLessThan(20);
    }
  });

  it("gives tiny homes none", () => {
    const map = emptyMap();
    const line = map.objects[MID];
    map.objects[MID] = `${line.slice(0, MID)}H${line.slice(MID + 1)}`;
    expect(chimneysOf(map)).toEqual([]);
  });
});

describe("window lights", () => {
  it("lights every wall of a home with windows on it", () => {
    const map = emptyMap();
    paintHome(map, MID, MID);
    // A 3×3 home: a window each on its three plain walls (its door wall
    // is too short either side of the door for one).
    expect(windowLightsOf(map)).toHaveLength(3);
  });
});
