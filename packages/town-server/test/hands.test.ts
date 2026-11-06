import { CAST_INTERVAL_MS, discCycleMs } from "@herzies/shared/combat";
import { describe, expect, it } from "vitest";
import { DiscHands, HAND_LENIENCY } from "../src/hands";

describe("a Slinger's two discs", () => {
  it("lets an honest pace through at any range", () => {
    for (const d of [3, 12, 18, 24]) {
      const h = new DiscHands();
      // The app's pace: the cast interval, and never before a disc is back.
      const back: [number, number] = [0, 0];
      let t = 1_000;
      for (let i = 0; i < 40; i++) {
        const k = back[0] <= back[1] ? 0 : 1;
        t = Math.max(t + CAST_INTERVAL_MS, back[k]);
        expect(h.take("a", t, d, 1), `at ${d} m, throw ${i}`).toBe(true);
        back[k] = t + discCycleMs(d);
      }
    }
  });

  it("refuses a third throw with both discs out", () => {
    const h = new DiscHands();
    expect(h.take("a", 1_000, 24, 1)).toBe(true);
    expect(h.take("a", 1_100, 24, 1)).toBe(true);
    expect(h.take("a", 1_200, 24, 1)).toBe(false);
    // Once the first is back (with the server's leniency), it may.
    expect(h.take("a", 1_000 + discCycleMs(24) * HAND_LENIENCY, 24, 1)).toBe(true);
  });

  it("each herzie has its own, and forgetting gives them back", () => {
    const h = new DiscHands();
    h.take("a", 0, null, 1);
    h.take("a", 0, null, 1);
    expect(h.take("b", 0, null, 1)).toBe(true);
    expect(h.take("a", 10, null, 1)).toBe(false);
    h.forget("a");
    expect(h.take("a", 10, null, 1)).toBe(true);
  });
});
