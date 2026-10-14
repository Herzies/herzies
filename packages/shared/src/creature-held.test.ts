import { describe, expect, it } from "vitest";
import {
  buildCreatureModel,
  CAST_ARM,
  creaturePoseOffsets,
  HELD_ARM,
  MAIN_HELD,
  type Sphere,
} from "./creature-renderer.js";
import type { Equipped } from "./items.js";

const USER = "held-test-user";
const PERCUSSIONIST: Equipped = {
  main_hand: "worn-stick",
  off_hand: "old-cymbal",
};

const centroid = (spheres: Sphere[], offsets: number[][], part: string) => {
  const at = [0, 0, 0];
  let n = 0;
  spheres.forEach((s, i) => {
    if (s.part !== part) return;
    for (let k = 0; k < 3; k++) at[k] += s.center[k] + offsets[i][k];
    n++;
  });
  return at.map((v) => v / n);
};

describe("held class equipment", () => {
  it("puts the main hand's gear in the casting arm", () => {
    expect(HELD_ARM[MAIN_HELD]).toBe(CAST_ARM);
  });

  it("holds nothing at stage 1, which has no arms", () => {
    const { spheres } = buildCreatureModel(USER, 1, PERCUSSIONIST);
    expect(spheres.some((s) => s.part in HELD_ARM)).toBe(false);
  });

  it("gives each held item its own parts, never the arm's", () => {
    for (const stage of [2, 3]) {
      const { spheres } = buildCreatureModel(USER, stage, PERCUSSIONIST);
      expect(spheres.filter((s) => s.part === "arm-l")).toHaveLength(1);
      expect(spheres.filter((s) => s.part === "arm-r")).toHaveLength(1);
      expect(spheres.some((s) => s.part === "held-l")).toBe(true);
      expect(spheres.some((s) => s.part === "held-r")).toBe(true);
    }
  });

  it("draws a disc in each hand from one Compact Discs item", () => {
    const { spheres } = buildCreatureModel(USER, 2, {
      main_hand: "compact-discs",
    });
    expect(spheres.some((s) => s.part === "held-l")).toBe(true);
    expect(spheres.some((s) => s.part === "held-r")).toBe(true);
  });

  it("keeps a prop the same distance from its arm through a cast", () => {
    const { spheres } = buildCreatureModel(USER, 3, PERCUSSIONIST);
    const rest = spheres.map(() => [0, 0, 0]);
    const gap = (offsets: number[][]) => {
      const arm = centroid(spheres, offsets, CAST_ARM);
      const prop = centroid(spheres, offsets, MAIN_HELD);
      return Math.hypot(...arm.map((v, k) => v - prop[k]));
    };
    const casting = creaturePoseOffsets(spheres, 3, {
      idleFrame: 0,
      walkPhase: 0,
      walkWeight: 0,
      castPhase: 0.5,
    });
    // The arm moved…
    const arm = spheres.findIndex((s) => s.part === CAST_ARM);
    expect(Math.hypot(...casting[arm])).toBeGreaterThan(0.01);
    // …and the stick came with it. (A cast stretches the arm a little, so
    // the gap scales with it rather than staying exact.)
    expect(gap(casting)).toBeGreaterThan(gap(rest) * 0.7);
    expect(gap(casting)).toBeLessThan(gap(rest) * 1.6);
  });
});
