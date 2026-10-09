import { describe, expect, it } from "vitest";
import { dayLook } from "./DayCycle";

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
