import { describe, expect, it } from "vitest";
import { buildingsOf } from "./map";
import { mapById } from "./maps";
import {
  hasCornice,
  TOWER_FADE,
  TOWER_FADE_LATE,
  TOWER_TOP,
  towerDoorSpot,
  towerFadeAt,
  towerFloors,
  towerPlace,
  towerRadiusAt,
} from "./towerPlan";

describe("the Tower's fade into the sky", () => {
  it("is all but nothing low down, half way at hm, and done well before the top", () => {
    expect(towerFadeAt(0)).toBeLessThan(0.01);
    expect(towerFadeAt(10)).toBeLessThan(0.03);
    expect(towerFadeAt(TOWER_FADE.hm)).toBeCloseTo(0.5, 9);
    expect(towerFadeAt(51)).toBeGreaterThan(0.9);
    expect(towerFadeAt(61)).toBeGreaterThan(0.999);
  });

  it("only ever thickens with height", () => {
    for (let y = 0; y < TOWER_TOP; y += 0.5) {
      expect(towerFadeAt(y + 0.5)).toBeGreaterThan(towerFadeAt(y));
    }
  });

  it("has every pixel a hole before the geometry ends, so its end is never drawn", () => {
    // The last tenth is the 4×4 dither: its highest threshold is 15.5/16.
    const { ditherFrom } = TOWER_FADE;
    const holes = (y: number) =>
      (towerFadeAt(y) - ditherFrom) / (1 - ditherFrom);
    expect(holes(TOWER_TOP - 5)).toBeGreaterThan(15.5 / 16);
    // Even its late-fading windows and clouds are gone by then.
    expect(holes(TOWER_TOP - TOWER_FADE_LATE)).toBeGreaterThan(15.5 / 16);
  });
});

describe("the Tower's floors", () => {
  const floors = towerFloors();

  it("stack up without gaps to the top, each shorter and narrower", () => {
    for (let i = 1; i < floors.length; i++) {
      const [a, b] = [floors[i - 1], floors[i]];
      expect(b.y).toBeCloseTo(a.y + a.h, 9);
      expect(b.h).toBeLessThan(a.h);
      expect(towerRadiusAt(b.y)).toBeLessThan(towerRadiusAt(a.y));
    }
    const last = floors[floors.length - 1];
    expect(last.y + last.h).toBeGreaterThanOrEqual(TOWER_TOP);
  });

  it("show two cornices before the fade takes hold", () => {
    const seen = floors.filter(
      (f) => hasCornice(f.n) && f.y + f.h < TOWER_FADE.hm,
    );
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
});

describe("the Tower on the home island", () => {
  const home = mapById("home");
  const tower = buildingsOf(home).find((b) => b.kind === "tower");

  // Wherever it's painted: these hold for its patch, not a fixed spot.
  const half = home.size / 2;

  it("stands on its 5×5 patch, centred on it, its door to the plaza", () => {
    expect(tower).toBeDefined();
    if (!tower) return;
    expect(tower.rects).toHaveLength(1);
    const r = tower.rects[0];
    expect(r).toMatchObject({ w: 5, h: 5 });
    expect(tower.door?.side).toBe("s");
    const at = towerPlace(tower);
    expect(at).toMatchObject({
      x: r.col + r.w / 2 - half,
      z: r.row + r.h / 2 - half,
      scale: 1,
    });
    expect(at.yaw).toBeCloseTo(0, 9);
  });

  it("puts its door's spot in front of the porch, facing out", () => {
    if (!tower) throw new Error("no tower");
    const r = tower.rects[0];
    const spot = towerDoorSpot(tower);
    expect(spot.x).toBeCloseTo(r.col + r.w / 2 - half, 9);
    // South of the patch's edge, not inside it, and not far off.
    const edge = r.row + r.h - half;
    expect(spot.z).toBeGreaterThan(edge);
    expect(spot.z).toBeLessThan(edge + 2);
  });
});
