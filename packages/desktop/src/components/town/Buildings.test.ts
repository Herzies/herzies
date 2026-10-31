import { describe, expect, it } from "vitest";
import { chimneysOf, windowLightsOf } from "./Buildings";
import {
  AUCTION_MAX_TURN,
  buildingsOf,
  emptyMap,
  MAP_SIZE,
  type TownMap,
} from "./map";

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

describe("the auction house", () => {
  it("lights its windows, but none behind the portico", () => {
    const map = emptyMap();
    // 4 wide, 8 deep, west of the middle: its door faces east, into town.
    for (let r = MID - 4; r < MID + 4; r++) {
      const line = map.objects[r];
      map.objects[r] = `${line.slice(0, MID - 12)}AAAA${line.slice(MID - 8)}`;
    }
    const [hall] = buildingsOf(map);
    expect(hall.kind).toBe("auction");
    expect(hall.door?.side).toBe("e");
    const lights = windowLightsOf(map);
    expect(lights.length).toBeGreaterThan(0);
    // Nothing looks out east, through the columns.
    expect(lights.filter(({ out }) => out[0] > 0.5)).toEqual([]);
  });
});

describe("turning toward town", () => {
  function paint(map: TownMap, ch: string, col: number, row: number) {
    for (let r = row; r < row + 4; r++) {
      const line = map.objects[r];
      map.objects[r] =
        `${line.slice(0, col)}${ch.repeat(4)}${line.slice(col + 4)}`;
    }
  }

  it("turns the auction house clockwise toward the middle, a little", () => {
    const map = emptyMap();
    // North-west of the middle, its door east: the middle is south-east of
    // it, so it turns clockwise (seen from above), as far as it may.
    paint(map, "A", MID - 14, MID - 12);
    const [hall] = buildingsOf(map);
    expect(hall.door?.side).toBe("e");
    expect(hall.turn).toBeCloseTo(-AUCTION_MAX_TURN);
  });

  it("leaves everything else square to the grid", () => {
    const map = emptyMap();
    paint(map, "$", MID - 14, MID - 12);
    expect(buildingsOf(map)[0].turn).toBe(0);
  });
});
