import { describe, expect, it } from "vitest";
import { FOOTPRINT_EVERY, Footprints, Trail } from "./footprints";
import { emptyMap, MAP_SIZE } from "./map";

const MID = MAP_SIZE / 2;

function walk(trail: Trail, prints: Footprints, from: number, to: number) {
  const map = emptyMap();
  for (let x = from; x <= to; x += 0.05) {
    trail.step(map, prints, x, 0, 0, 1, x * 0.1);
  }
}

describe("footprints", () => {
  it("leaves prints evenly spaced along the way, in snow", () => {
    const prints = new Footprints(64);
    walk(new Trail(0), prints, 0, 4);
    const n = prints.live(0.4).length;
    expect(n).toBeGreaterThanOrEqual(Math.floor(4 / FOOTPRINT_EVERY) - 1);
    expect(n).toBeLessThanOrEqual(Math.ceil(4 / FOOTPRINT_EVERY) + 1);
  });

  it("puts a herzie on legs' prints under its feet, either side", () => {
    const prints = new Footprints(64);
    walk(new Trail(0.35), prints, 0, 3);
    const sides = new Set(prints.live(0.3).map((p) => p.z.toFixed(2)));
    expect(sides).toEqual(new Set(["0.35", "-0.35"]));
  });

  it("leaves one bigger print down the middle for a herzie that hops", () => {
    const prints = new Footprints(64);
    walk(new Trail(0), prints, 0, 3);
    const live = prints.live(0.3);
    expect(new Set(live.map((p) => p.z))).toEqual(new Set([0]));
    expect(live[0].size).toBeGreaterThan(1);
  });

  it("leaves none without snow", () => {
    const prints = new Footprints(64);
    const map = emptyMap();
    const trail = new Trail(0);
    for (let x = 0; x < 3; x += 0.05) trail.step(map, prints, x, 0, 0, 0, x);
    expect(prints.live(3)).toEqual([]);
  });

  it("leaves none in water", () => {
    const prints = new Footprints(64);
    const map = emptyMap();
    map.terrain = map.terrain.map((row) => "~".repeat(row.length));
    const trail = new Trail(0);
    for (let x = 0; x < 3; x += 0.05) trail.step(map, prints, x, 0, 0, 1, x);
    expect(prints.live(3)).toEqual([]);
  });

  it("fades them out after a second or two", () => {
    const prints = new Footprints(64);
    walk(new Trail(0), prints, 0, 1);
    expect(prints.live(0.1).length).toBeGreaterThan(0);
    expect(prints.live(10)).toEqual([]);
  });

  it("starts a fresh trail after standing still or jumping somewhere", () => {
    const prints = new Footprints(64);
    const map = emptyMap();
    const trail = new Trail(0);
    trail.step(map, prints, 0, 0, 0, 1, 0);
    // Respawned across the island: no line of prints between.
    trail.step(map, prints, MID - 2, 0, 0, 1, 0.1);
    expect(prints.live(0.1)).toEqual([]);
  });
});
