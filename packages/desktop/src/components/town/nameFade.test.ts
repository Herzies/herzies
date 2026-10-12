import { describe, expect, it } from "vitest";
import { NAME_FADE, nameOpacity } from "./nameFade";

describe("nameOpacity", () => {
  it("is gone far off, there up close, and eases between", () => {
    expect(nameOpacity(NAME_FADE.far + 5)).toBe(0);
    expect(nameOpacity(NAME_FADE.far)).toBe(0);
    expect(nameOpacity(NAME_FADE.near)).toBe(1);
    expect(nameOpacity(0)).toBe(1);
    const mid = nameOpacity((NAME_FADE.far + NAME_FADE.near) / 2);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
  });

  it("never gets less visible as you come closer", () => {
    let last = 0;
    for (let d = 20; d >= 0; d -= 0.5) {
      const o = nameOpacity(d);
      expect(o).toBeGreaterThanOrEqual(last);
      last = o;
    }
  });
});
