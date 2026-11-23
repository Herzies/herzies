import { describe, expect, it } from "vitest";
import { behindToward, swingAzimuth } from "./swing";

/** The same angle, whole turns apart. */
const sameAngle = (a: number, b: number) =>
  expect(Math.cos(a - b)).toBeCloseTo(1, 6);

describe("behindToward", () => {
  it("puts the camera on the far side from what you face", () => {
    // Facing +x: the camera sits on −x, i.e. the opponent is ahead.
    const az = behindToward({ x: 0, z: 0 }, { x: 10, z: 0 });
    // camera-controls puts the camera at (sin az, cos az) from the target.
    expect(Math.sin(az)).toBeCloseTo(-1);
    expect(Math.cos(az)).toBeCloseTo(0);
    sameAngle(behindToward({ x: 0, z: 0 }, { x: 0, z: 5 }), Math.PI);
  });
});

describe("swingAzimuth", () => {
  it("starts where the camera is and ends where it should be", () => {
    expect(swingAzimuth(0.3, 2, 0)).toBeCloseTo(0.3);
    sameAngle(swingAzimuth(0.3, 2, 1), 2);
    sameAngle(swingAzimuth(0.3, 2, 7), 2);
  });

  it("eases in and out, halfway at the middle", () => {
    expect(swingAzimuth(0, 1, 0.5)).toBeCloseTo(0.5);
    expect(swingAzimuth(0, 1, 0.1)).toBeLessThan(0.1);
    expect(swingAzimuth(0, 1, 0.9)).toBeGreaterThan(0.9);
  });

  it("turns the short way round, never more than half a circle", () => {
    // From just under a full turn to just over zero: a small step forward,
    // not a spin back.
    const from = 2 * Math.PI - 0.2;
    const mid = swingAzimuth(from, 0.2, 0.5);
    sameAngle(mid, 0);
    expect(Math.abs(mid - from)).toBeLessThan(0.25);
    for (let t = 0; t <= 1; t += 0.1)
      expect(Math.abs(swingAzimuth(-3, 3, t) - -3)).toBeLessThanOrEqual(
        2 * Math.PI - 6 + 1e-9,
      );
  });
});
