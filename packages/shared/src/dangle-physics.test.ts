import { describe, expect, it } from "vitest";
import {
  createDangleSim,
  DEFAULT_DANGLE_CONFIG,
  dangleState,
  isDangleSettled,
  steadyDangle,
  stepDangle,
} from "./dangle-physics.js";

const FRAME = 1 / 60;

/** Spin the body at `speed` rad/s for `seconds`, then hold it still for
 * `holdSeconds`, recording the swing every frame. */
function run(speed: number, seconds: number, holdSeconds: number) {
  const sim = createDangleSim(0);
  let body = 0;
  const spinning: number[] = [];
  const held: number[] = [];
  for (let t = 0; t < seconds; t += FRAME) {
    body += speed * FRAME;
    stepDangle(sim, body, FRAME);
    spinning.push(dangleState(sim, body).swing);
  }
  for (let t = 0; t < holdSeconds; t += FRAME) {
    stepDangle(sim, body, FRAME);
    held.push(dangleState(sim, body).swing);
  }
  return { sim, body, spinning, held };
}

describe("dangle physics", () => {
  it("trails behind a spin", () => {
    const { spinning } = run(3, 0.3, 0);
    expect(Math.min(...spinning)).toBeLessThan(-0.05);
  });

  it("follows through when the spin stops, then settles", () => {
    const { sim, body, held } = run(6, 0.5, 6);
    // Overshoot: it was trailing (negative), so it swings positive.
    expect(Math.max(...held)).toBeGreaterThan(0.05);
    expect(isDangleSettled(sim, body)).toBe(true);
  });

  it("holds the steady trail a constant spin gives it", () => {
    const speed = 2;
    const { spinning } = run(speed, 4, 0);
    // Within a substep's worth of spin (speed / 240) of the closed form: the
    // spring is evaluated one substep before the angle it's measured at.
    expect(
      Math.abs((spinning.at(-1) ?? 0) - steadyDangle(speed).swing),
    ).toBeLessThan(0.015);
  });

  it("isn't towed behind a steady spin, only swung by it changing", () => {
    // A fast, steady drag (~1300px/s). The old model damped against the
    // chain's absolute speed, which pinned it at maxSwing for the whole drag.
    const { spinning } = run(20, 2, 0);
    expect(Math.abs(spinning.at(-1) ?? 0)).toBeLessThan(
      DEFAULT_DANGLE_CONFIG.maxSwing / 2,
    );
  });

  it("never swings past maxSwing however hard it's spun", () => {
    const { spinning, held } = run(80, 0.5, 2);
    for (const swing of [...spinning, ...held]) {
      expect(Math.abs(swing)).toBeLessThanOrEqual(
        DEFAULT_DANGLE_CONFIG.maxSwing,
      );
    }
  });

  it("flares out with spin speed", () => {
    expect(steadyDangle(0).flare).toBe(0);
    expect(steadyDangle(DEFAULT_DANGLE_CONFIG.flareSpeed).flare).toBe(1);
    expect(steadyDangle(4).flare).toBeGreaterThan(0);
  });
});
