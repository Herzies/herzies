import { describe, expect, it } from "vitest";
import { casterFades } from "./Lamps";

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
