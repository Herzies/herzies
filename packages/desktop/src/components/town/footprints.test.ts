import { STRIDE } from "@herzies/shared/gl";
import { describe, expect, it } from "vitest";
import { SNOW_DEPTH_TRODDEN, snowCovers } from "./ambient";
import { FOOTPRINT_EVERY, Footprints, Trail } from "./footprints";
import { emptyMap, MAP_SIZE, type TownMap } from "./map";

const MID = MAP_SIZE / 2;

/** Walks along x from `from` to `to`, its walk cycle keeping pace with the
 * ground as HerzieModel's does. */
function walk(
  trail: Trail,
  prints: Footprints,
  from: number,
  to: number,
  map: TownMap = emptyMap(),
  snow = 1,
) {
  for (let x = from; x <= to; x += 0.05) {
    const phase = ((((x - from) / STRIDE) % 1) + 1) % 1;
    trail.step(map, prints, x, 0, 0, snow, x * 0.1, phase);
  }
}

describe("footprints", () => {
  it("leaves a walker's prints evenly spaced along the way, in snow", () => {
    const prints = new Footprints(64);
    walk(new Trail(0.35), prints, 0, 4);
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

  it("leaves one bigger print down the middle where each hop lands", () => {
    const prints = new Footprints(64);
    walk(new Trail(0), prints, 0, 6.5);
    const live = prints.live(0.65);
    expect(live.map((p) => p.x.toFixed(1))).toEqual(
      [1, 2, 3, 4, 5].map((k) => ((k * STRIDE) / 2).toFixed(1)),
    );
    expect(new Set(live.map((p) => p.z))).toEqual(new Set([0]));
    expect(live[0].size).toBeGreaterThan(1);
  });

  it("leaves none without snow", () => {
    const prints = new Footprints(64);
    walk(new Trail(0.35), prints, 0, 3, emptyMap(), 0);
    expect(prints.live(3)).toEqual([]);
  });

  it("leaves none in water", () => {
    const prints = new Footprints(64);
    const map = emptyMap();
    map.terrain = map.terrain.map((row) => "~".repeat(row.length));
    walk(new Trail(0.35), prints, 0, 3, map);
    expect(prints.live(3)).toEqual([]);
  });

  it("leaves them only where the snow is drawn on a path's patches", () => {
    const prints = new Footprints(512);
    const map = emptyMap();
    map.terrain = map.terrain.map((row) => row.replaceAll(".", "g"));
    walk(new Trail(0.35), prints, -30, 30, map);
    const live = prints.prints;
    // Some of the way's bare gravel, and none of the prints are on it.
    expect(live.length).toBeGreaterThan(0);
    expect(live.length).toBeLessThan(60 / FOOTPRINT_EVERY - 1);
    for (const p of live) {
      expect(snowCovers(p.x, p.z, SNOW_DEPTH_TRODDEN)).toBe(true);
    }
  });

  it("fades them out after a second or two", () => {
    const prints = new Footprints(64);
    walk(new Trail(0.35), prints, 0, 1);
    expect(prints.live(0.1).length).toBeGreaterThan(0);
    expect(prints.live(10)).toEqual([]);
  });

  it("starts a fresh trail after jumping somewhere", () => {
    const prints = new Footprints(64);
    const map = emptyMap();
    const trail = new Trail(0);
    trail.step(map, prints, 0, 0, 0, 1, 0, 0.4);
    // Respawned across the island: no prints between.
    trail.step(map, prints, MID - 2, 0, 0, 1, 0.1, 0.6);
    expect(prints.live(0.1)).toEqual([]);
  });
});
