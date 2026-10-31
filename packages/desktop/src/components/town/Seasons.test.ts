import { describe, expect, it } from "vitest";
import { dayOfYear, seasonLook } from "./Seasons";

const on = (month: number, day: number) =>
  dayOfYear(new Date(2026, month - 1, day, 12));

describe("seasons", () => {
  it("counts the day of the year from the 1st of January", () => {
    expect(on(1, 1)).toBeCloseTo(0.5, 1);
    expect(on(12, 31)).toBeGreaterThan(364);
  });

  it("is winter in January and summer in July", () => {
    expect(seasonLook(on(1, 20)).snow).toBe(1);
    expect(seasonLook(on(1, 20)).ice).toBe(1);
    expect(seasonLook(on(7, 15)).snow).toBe(0);
    expect(seasonLook(on(7, 15)).butterflies).toBe(1);
    expect(seasonLook(on(7, 15)).fall).toBe(0);
  });

  it("turns the leaves at the end of October", () => {
    const look = seasonLook(on(10, 31));
    expect(look.fall).toBe(1);
    expect(look.leaves).toBe(1);
    expect(look.snow).toBe(0);
  });

  it("blossoms in spring, and the oaks are bare in winter", () => {
    expect(seasonLook(on(4, 20)).blossom).toBe(1);
    expect(seasonLook(on(4, 20)).bare).toBe(0);
    expect(seasonLook(on(1, 20)).bare).toBe(1);
    expect(seasonLook(on(7, 15)).blossom).toBe(0);
  });

  it("blends between seasons rather than switching", () => {
    const thaw = seasonLook(on(3, 1)).snow;
    expect(thaw).toBeGreaterThan(0);
    expect(thaw).toBeLessThan(1);
  });

  it("wraps round the new year smoothly", () => {
    const before = seasonLook(365.9);
    const after = seasonLook(0.1);
    expect(Math.abs(before.snow - after.snow)).toBeLessThan(0.01);
    expect(seasonLook(365 + 200)).toEqual(seasonLook(200));
    expect(seasonLook(-165)).toEqual(seasonLook(200));
  });

  it("leaves summer looking as the Town always has", () => {
    const summer = seasonLook(on(7, 15));
    expect(summer.grass.getHex()).toBe(0xffffff);
    expect(summer.leaf.getHex()).toBe(0xffffff);
  });
});
