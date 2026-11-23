import { describe, expect, it } from "vitest";
import { HerzieModel } from "./HerzieModel.js";
import { PipeSmoke } from "./pipeSmoke.js";

const LOOK = {
  seed: "smoke-test",
  stage: 3,
  equipped: { face: "sailors-starter-pack" },
};

/** The model's smoke (a private field), or null without a pipe. */
const smokeOf = (h: HerzieModel) => {
  const smoke: unknown = Reflect.get(h, "smoke");
  return smoke instanceof PipeSmoke ? smoke : null;
};

describe("pipe smoke", () => {
  it("puffs now and then, rising from the pipe, and only with one", () => {
    const h = new HerzieModel(LOOK);
    const smoke = smokeOf(h);
    expect(smoke).not.toBeNull();
    // A paused view keeps drawing it.
    expect(h.glittering).toBe(true);
    if (!smoke) return;
    const g = smoke.points.geometry;
    const alpha = g.getAttribute("aAlpha").array;
    const pos = g.getAttribute("position").array;
    let most = 0;
    let brightest = 0;
    let rose = false;
    for (let i = 0; i < 60 * 12; i++) {
      h.update(1 / 60, 0);
      // Slot 0 is the ember's glow; the rest are smoke.
      brightest = Math.max(brightest, alpha[0]);
      let alive = 0;
      for (let k = 1; k < alpha.length; k++) {
        if (alpha[k] <= 0) continue;
        alive++;
        if (pos[k * 3 + 1] > pos[1] + h.height * 0.1) rose = true;
      }
      most = Math.max(most, alive);
    }
    // A draw (the ember all aglow) and the puff after it, not just wisps.
    expect(brightest).toBeGreaterThan(0.8);
    expect(most).toBeGreaterThanOrEqual(6);
    expect(rose).toBe(true);

    const plain = new HerzieModel({ ...LOOK, equipped: {} });
    expect(smokeOf(plain)).toBeNull();
    expect(plain.glittering).toBe(false);
  });
});
