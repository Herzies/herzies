import { describe, expect, it } from "vitest";
import { dayLook, SUNRISE, SUNSET, skyLights } from "./DayCycle";

describe("day cycle", () => {
  it("is night at midnight and day at noon", () => {
    expect(dayLook(0).night).toBe(1);
    expect(dayLook(12).night).toBe(0);
    expect(dayLook(12).windows).toBe(0);
    expect(dayLook(23).windows).toBe(1);
  });

  it("is brighter by day than by night", () => {
    expect(dayLook(12).hemiIntensity).toBeGreaterThan(dayLook(0).hemiIntensity);
    expect(
      dayLook(12).skyHorizon.getHSL({ h: 0, s: 0, l: 0 }).l,
    ).toBeGreaterThan(dayLook(0).skyHorizon.getHSL({ h: 0, s: 0, l: 0 }).l);
  });

  it("wraps round midnight smoothly", () => {
    const before = dayLook(23.99);
    const after = dayLook(0.01);
    const gap = (a: typeof before.skyTop, b: typeof after.skyTop) =>
      Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
    expect(gap(before.skyTop, after.skyTop)).toBeLessThan(0.01);
    expect(Math.abs(before.night - after.night)).toBeLessThan(0.01);
    expect(dayLook(24 + 12)).toEqual(dayLook(12));
    expect(dayLook(-12)).toEqual(dayLook(12));
  });

  it("changes gradually between keyframes", () => {
    const a = dayLook(18).night;
    const b = dayLook(18.1).night;
    expect(Math.abs(a - b)).toBeLessThan(0.05);
  });
});

describe("sun and moon", () => {
  it("has the sun up by day and the moon up by night", () => {
    expect(skyLights(12.5).sun.y).toBeGreaterThan(0.8);
    expect(skyLights(0.5).sun.y).toBeLessThan(-0.8);
    // The moon rides low, but up.
    expect(skyLights(0.5).moon.y).toBeGreaterThan(0.15);
    expect(skyLights(0.5).moon.y).toBeLessThan(0.25);
    expect(skyLights(12.5).moon.y).toBeLessThan(0);
    expect(Math.abs(skyLights(SUNRISE).sun.y)).toBeLessThan(1e-9);
    expect(Math.abs(skyLights(SUNSET).sun.y)).toBeLessThan(1e-9);
    // Rises in the east, sets in the west.
    expect(skyLights(SUNRISE + 0.5).sun.x).toBeGreaterThan(0);
    expect(skyLights(SUNSET - 0.5).sun.x).toBeLessThan(0);
  });

  it("keeps every direction unit length", () => {
    for (let h = 0; h < 24; h += 0.37) {
      const s = skyLights(h);
      for (const v of [s.sun, s.moon, s.light, s.herzie]) {
        expect(v.length()).toBeCloseTo(1, 9);
      }
    }
  });

  it("moves smoothly, and fades the light where it switches", () => {
    for (let h = 0; h < 24; h += 0.05) {
      const a = skyLights(h);
      const b = skyLights(h + 0.05);
      expect(a.sun.distanceTo(b.sun)).toBeLessThan(0.03);
      expect(Math.abs(a.strength - b.strength)).toBeLessThan(0.1);
      // The light jumps only while it is faded out.
      if (a.light.distanceTo(b.light) > 0.03) {
        expect(Math.max(a.strength, b.strength)).toBe(0);
      }
    }
    expect(skyLights(23.99).sun.distanceTo(skyLights(0.01).sun)).toBeLessThan(
      0.01,
    );
  });

  it("never lets the light graze, and keeps the herzies' light mid-high", () => {
    for (let h = 0; h < 24; h += 0.25) {
      const s = skyLights(h);
      expect(s.light.y).toBeGreaterThanOrEqual(
        Math.sin((12 * Math.PI) / 180) - 1e-9,
      );
      expect(s.herzie.y).toBeGreaterThanOrEqual(
        Math.sin((25 * Math.PI) / 180) - 1e-9,
      );
      expect(s.herzie.y).toBeLessThanOrEqual(
        Math.sin((60 * Math.PI) / 180) + 1e-9,
      );
    }
  });
});
