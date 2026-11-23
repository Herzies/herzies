import { describe, expect, it } from "vitest";
import { type BellPose, bellStrikeAt, CLAPPER_HIT, poseBell } from "./bell";

const pose: BellPose = { swing: 0, clapper: 0 };

describe("the ship's bell", () => {
  it("strikes in pairs: ding-ding, a breath, ding-ding", () => {
    [0, 0.34, 1.14, 1.48].forEach((at, i) => {
      expect(bellStrikeAt(i)).toBeCloseTo(at, 9);
    });
  });

  it("puts the clapper on the rim on every strike, and only then", () => {
    for (const strikes of [2, 3]) {
      for (let i = 0; i < strikes; i++) {
        const at = bellStrikeAt(i);
        expect(poseBell(at, strikes, pose).clapper).toBeCloseTo(CLAPPER_HIT, 9);
        // Not on the rim just before a blow.
        expect(poseBell(at - 0.03, strikes, pose).clapper).toBeLessThan(
          CLAPPER_HIT,
        );
      }
      // Off the rim between the pair's blows.
      expect(Math.abs(poseBell(0.2, strikes, pose).clapper)).toBeLessThan(
        CLAPPER_HIT,
      );
    }
  });

  it("hangs still until it's rung, and again once it's done", () => {
    for (const since of [-1, Number.NaN, Number.POSITIVE_INFINITY, 20]) {
      poseBell(since, 3, pose);
      expect(pose).toEqual({ swing: 0, clapper: 0 });
    }
    // Rung: the first blow at once.
    poseBell(1 / 60, 2, pose);
    expect(pose.swing).toBeGreaterThan(0);
    expect(pose.clapper).toBe(CLAPPER_HIT);
  });
});
