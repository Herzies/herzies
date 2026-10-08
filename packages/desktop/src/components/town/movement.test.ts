import { describe, expect, it } from "vitest";
import {
  angleDelta,
  newAnimationState,
  quantizePose,
  STRIDE,
  stepAnimation,
  WALK_SPEED,
} from "./animation";
import type { TownInput } from "./input";
import { type Mover, stepMover, walkAzimuth } from "./movement";

const DT = 1 / 60;
const idle = (): TownInput => ({
  forward: false,
  back: false,
  left: false,
  right: false,
  mouseLeft: false,
  mouseRight: false,
});
const run = (
  m: Mover,
  input: Partial<TownInput>,
  azimuth: number,
  secs: number,
) => {
  for (let t = 0; t < secs; t += DT)
    stepMover(m, { ...idle(), ...input }, azimuth, DT);
};
const mover = (heading = Math.PI): Mover => ({ vx: 0, vz: 0, heading });

describe("stepMover", () => {
  it("W walks away from the camera, up to walking speed", () => {
    const m = mover();
    run(m, { forward: true }, 0, 2);
    // Camera on +z (azimuth 0) looks toward -z.
    expect(m.vz).toBeCloseTo(-WALK_SPEED, 2);
    expect(m.vx).toBeCloseTo(0, 5);
  });

  it("walks relative to wherever the camera has been swung", () => {
    const m = mover();
    run(m, { forward: true }, Math.PI / 2, 2);
    // Camera on +x looks toward -x.
    expect(m.vx).toBeCloseTo(-WALK_SPEED, 2);
    expect(m.vz).toBeCloseTo(0, 2);
  });

  it("D strafes to the camera's right; diagonals aren't faster", () => {
    const m = mover();
    run(m, { right: true }, 0, 2);
    expect(m.vx).toBeCloseTo(WALK_SPEED, 2);
    const d = mover();
    run(d, { forward: true, right: true }, 0, 2);
    expect(Math.hypot(d.vx, d.vz)).toBeCloseTo(WALK_SPEED, 2);
  });

  it("eases in, and stops quicker than it starts", () => {
    const m = mover();
    run(m, { forward: true }, 0, 0.1);
    const after = Math.abs(m.vz);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(WALK_SPEED * 0.75);
    run(m, { forward: true }, 0, 2);
    run(m, {}, 0, 0.1);
    expect(Math.abs(m.vz)).toBeLessThan(WALK_SPEED - after);
  });

  it("without the right button, turns to face where it walks (the short way)", () => {
    const m = mover(Math.PI); // facing -z
    run(m, { right: true }, 0, 2); // walking +x
    expect(angleDelta(m.heading, Math.PI / 2)).toBeCloseTo(0, 2);
  });

  it("left-drag orbiting alone never turns the herzie", () => {
    const m = mover(1);
    run(m, { mouseLeft: true }, 2.5, 1);
    expect(m.heading).toBe(1);
  });

  it("right button: faces the camera's way, and A/D strafe without turning", () => {
    const az = 0.8;
    const m = mover(Math.PI);
    run(m, { mouseRight: true }, az, 1);
    const cameraWay = Math.atan2(-Math.sin(az), -Math.cos(az));
    expect(angleDelta(m.heading, cameraWay)).toBeCloseTo(0, 2);
    run(m, { mouseRight: true, left: true }, az, 1);
    expect(angleDelta(m.heading, cameraWay)).toBeCloseTo(0, 2);
    expect(Math.hypot(m.vx, m.vz)).toBeGreaterThan(WALK_SPEED * 0.9);
  });

  it("left-drag while walking looks around without changing course", () => {
    let az: number | null = null;
    const m = mover();
    // Walk with the camera at 0, then orbit it with the left button held.
    for (let i = 0; i < 120; i++) {
      az = walkAzimuth(az, 0, { ...idle(), forward: true });
      stepMover(m, { ...idle(), forward: true }, az, DT);
    }
    for (let i = 0; i < 120; i++) {
      const input = { ...idle(), forward: true, mouseLeft: true };
      az = walkAzimuth(az, (i / 120) * 2, input);
      stepMover(m, input, az, DT);
    }
    expect(m.vx).toBeCloseTo(0, 5);
    expect(m.vz).toBeCloseTo(-WALK_SPEED, 2);
    // With the right button, the walk follows the camera.
    az = walkAzimuth(az, 2, { ...idle(), mouseRight: true });
    expect(az).toBe(2);
  });

  it("both buttons walk forward", () => {
    const m = mover();
    run(m, { mouseLeft: true, mouseRight: true }, 0, 2);
    expect(m.vz).toBeCloseTo(-WALK_SPEED, 2);
  });
});

describe("animation clocks", () => {
  it("advances the walk cycle by distance, not time", () => {
    const a = newAnimationState();
    const b = newAnimationState();
    // Same ground covered at different speeds: same point in the cycle.
    for (let i = 0; i < 30; i++) stepAnimation(a, DT, 2);
    for (let i = 0; i < 15; i++) stepAnimation(b, DT, 4);
    expect(a.walkPhase).toBeCloseTo(b.walkPhase, 6);
    expect(a.walkPhase).toBeCloseTo((2 * 30 * DT) / STRIDE, 6);
  });

  it("blends into walking and back out to standing", () => {
    const s = newAnimationState();
    for (let i = 0; i < 60; i++) stepAnimation(s, DT, WALK_SPEED);
    expect(s.walkWeight).toBeGreaterThan(0.99);
    for (let i = 0; i < 60; i++) stepAnimation(s, DT, 0);
    expect(s.walkWeight).toBe(0);
  });

  it("caches standing frames without the walk phase, and walking ones without the breath", () => {
    const s = newAnimationState();
    const key = (anim: typeof s) =>
      quantizePose({ yAngle: 0, pitch: 0, anim, breathesWhileWalking: false })
        .key;
    expect(key({ ...s, walkPhase: 0.1 })).toBe(key({ ...s, walkPhase: 0.6 }));
    const walking = { ...s, walkWeight: 1 };
    expect(key({ ...walking, idleTime: 0.1 })).toBe(
      key({ ...walking, idleTime: 2 }),
    );
    expect(key({ ...walking, walkPhase: 0.1 })).not.toBe(
      key({ ...walking, walkPhase: 0.6 }),
    );
  });

  it("wraps turn angles into one of 36 steps", () => {
    const anim = newAnimationState();
    const at = (yAngle: number) =>
      quantizePose({ yAngle, pitch: 0, anim, breathesWhileWalking: false }).pose
        .yAngle;
    expect(at(-0.01)).toBeCloseTo(0, 6);
    expect(at(Math.PI * 4 + 0.17)).toBeCloseTo((Math.PI * 2) / 36, 6);
  });
});
