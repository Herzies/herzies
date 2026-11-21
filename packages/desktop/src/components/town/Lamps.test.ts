import { describe, expect, it } from "vitest";
import { casterFades, glowsOf, lightPools } from "./Lamps";
import { mapById, TOWN_MAPS_LOCAL } from "./maps";

describe("lamp shadow hand-over", () => {
  it("casts fully when well nearer than the next light", () => {
    expect(casterFades([1, 2, 3, 9], 3, 2)).toEqual([1, 1, 1]);
  });

  it("fades the farthest caster out as the next light comes as near", () => {
    const [, , last] = casterFades([1, 2, 5, 6], 3, 2);
    expect(last).toBeCloseTo(0.5, 9);
    // Level with it: the swap shows no shadow either side.
    expect(casterFades([1, 2, 5, 5], 3, 2)[2]).toBe(0);
  });

  it("casts fully when there's no light to hand over to", () => {
    expect(casterFades([1, 4], 3, 2)).toEqual([1, 1]);
  });
});

describe("light pools", () => {
  it("lights as many lamps and windows on every island in the sky", () => {
    const sky = [...TOWN_MAPS_LOCAL.values()].filter((m) => !m.room && !m.ship);
    expect(sky.length).toBeGreaterThan(1);
    const pools = sky.map((m) => lightPools(m));
    for (const p of pools) expect(p).toEqual(pools[0]);
    // Never fewer than an island's own.
    for (const m of sky) {
      const glows = glowsOf(m);
      expect(pools[0].lamps + pools[0].windows).toBeGreaterThanOrEqual(
        glows.length,
      );
    }
  });

  it("leaves a room its own lights", () => {
    const cave = mapById("bossroom");
    const glows = glowsOf(cave);
    const lamps = glows.filter((g) => !g.out).length;
    expect(lightPools(cave, glows, { lamps: 99, windows: 99 })).toEqual({
      lamps,
      windows: glows.length - lamps,
    });
  });
});
