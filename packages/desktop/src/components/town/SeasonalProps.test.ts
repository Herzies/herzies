import { describe, expect, it } from "vitest";
import { emptyMap } from "./map";
import { placeSeasonal } from "./Props";
import { HOME_MAP } from "./runtime";

describe("seasonal props", () => {
  it("puts pumpkins and a few snowmen beside the paths of the home island", () => {
    const { pumpkins, snowmen } = placeSeasonal(HOME_MAP, []);
    expect(pumpkins.length).toBeGreaterThan(3);
    expect(snowmen.length).toBeGreaterThan(0);
    expect(snowmen.length).toBeLessThanOrEqual(3);
  });

  it("puts nothing on an island with no paths", () => {
    const { pumpkins, snowmen } = placeSeasonal(emptyMap(), []);
    expect(pumpkins).toEqual([]);
    expect(snowmen).toEqual([]);
  });

  it("heaps leaves under every other oak", () => {
    const oak = { x: 0, y: 0, z: 0, scale: 1, yaw: 0 };
    const { leafPiles } = placeSeasonal(HOME_MAP, [oak, oak, oak, oak]);
    expect(leafPiles).toHaveLength(2);
  });
});
