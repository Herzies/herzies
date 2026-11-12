import { describe, expect, it } from "vitest";
import {
  createTieSim,
  isTieSettled,
  stepTieSim,
  type TieRig,
} from "./tie-physics.js";

// A blade lying down the front of a unit-ish torso.
const center: [number, number, number] = [0, 10, 0];
const R = 8;
const rest = [1, 2, 3, 4, 5].map((i): [number, number, number] => {
  const y = 4 + i * 1.6;
  const dy = y - center[1];
  return [0, y, -Math.sqrt(R * R - dy * dy) - 0.1];
});
const root: [number, number, number] = [0, 4, -Math.sqrt(R * R - 36) - 0.1];
const lengths = rest.map((p, i) => {
  const from = i === 0 ? root : rest[i - 1];
  return Math.hypot(p[0] - from[0], p[1] - from[1], p[2] - from[2]);
});
const rig: TieRig = {
  root,
  rest,
  lengths,
  center,
  clear: rest.map(
    (p) =>
      Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) - 0.05,
  ),
};
const still = {
  offset: [0, 0, 0] as [number, number, number],
  accel: [0, 0, 0] as [number, number, number],
  turnRate: 0,
};

describe("tie physics", () => {
  it("lies still where it was built", () => {
    const sim = createTieSim(rig);
    for (let i = 0; i < 120; i++) stepTieSim(sim, rig, 1 / 60, still);
    for (const [i, p] of sim.pos.entries()) {
      expect(
        Math.hypot(p[0] - rest[i][0], p[1] - rest[i][1], p[2] - rest[i][2]),
      ).toBeLessThan(0.05);
    }
    expect(isTieSettled(sim)).toBe(true);
  });

  it("swings out a little when the herzie speeds up, then settles", () => {
    const sim = createTieSim(rig);
    let most = 0;
    for (let i = 0; i < 20; i++) {
      stepTieSim(sim, rig, 1 / 60, { ...still, accel: [0, 0, 20] });
      const tip = sim.pos[sim.pos.length - 1];
      most = Math.max(
        most,
        Math.hypot(
          tip[0] - rest[4][0],
          tip[1] - rest[4][1],
          tip[2] - rest[4][2],
        ),
      );
    }
    expect(most).toBeGreaterThan(0.02);
    for (let i = 0; i < 240; i++) stepTieSim(sim, rig, 1 / 60, still);
    expect(isTieSettled(sim)).toBe(true);
  });

  it("stays on the chest, never stretches, however hard it's thrown", () => {
    const sim = createTieSim(rig);
    for (let i = 0; i < 300; i++) {
      stepTieSim(sim, rig, 1 / 30, {
        offset: [0, Math.sin(i) * 0.5, 0],
        accel: [Math.sin(i * 3) * 500, 500, Math.cos(i * 2) * 500],
        turnRate: Math.sin(i) * 50,
        velocity: [100, 0, 100],
      });
      sim.pos.forEach((p, k) => {
        expect(Number.isFinite(p[0] + p[1] + p[2])).toBe(true);
        expect(
          Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]),
        ).toBeGreaterThan(rig.clear[k] - 0.2);
        const from = k === 0 ? root : sim.pos[k - 1];
        const d = Math.hypot(p[0] - from[0], p[1] - from[1], p[2] - from[2]);
        expect(d).toBeLessThan(lengths[k] * 1.25);
      });
    }
  });
});
