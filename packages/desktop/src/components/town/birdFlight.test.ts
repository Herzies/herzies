import { mulberry32 } from "@herzies/shared";
import { describe, expect, it } from "vitest";
import {
  FLIGHT,
  FOLDED,
  isPerched,
  perchedBird,
  type Spot,
  startFlight,
  stepBird,
  wingWave,
} from "./birdFlight";

const A: Spot = { x: 0, y: 4, z: 0, yaw: 0.5 };
const B: Spot = { x: 14, y: 3.2, z: 9, yaw: 2 };
const DT = 1 / 60;

/** Flies a bird from A to B at 60 fps, recording every frame. */
function fly(startled = false, seed = 7, to: Spot = B) {
  const rand = mulberry32(seed);
  const bird = perchedBird(A, seed, rand);
  // Sits a moment first (its idle habits run).
  for (let i = 0; i < 30; i++) stepBird(bird, DT, rand);
  expect(startFlight(bird, to, startled, rand)).toBe(true);
  const frames: {
    t: number;
    x: number;
    y: number;
    z: number;
    phase: string;
    speed: number;
    rate: number;
    amp: number;
    beat: number;
  }[] = [];
  let t = 0;
  while (t < 20) {
    const p = stepBird(bird, DT, rand);
    t += DT;
    frames.push({
      t,
      x: p.x,
      y: p.y,
      z: p.z,
      phase: bird.phase,
      speed: bird.speed,
      rate: bird.rate,
      amp: bird.amp,
      beat: p.beat,
    });
    if (isPerched(bird) && t > 0.5) break;
  }
  return { bird, frames };
}

describe("wingWave", () => {
  it("is continuous, within -1..1, and lopsided: down in 40%, up in 60%", () => {
    let last = wingWave(0);
    for (let p = 0.001; p <= 2; p += 0.001) {
      const w = wingWave(p);
      expect(Math.abs(w)).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.abs(w - last)).toBeLessThan(0.02);
      last = w;
    }
    expect(wingWave(0)).toBeCloseTo(1);
    expect(wingWave(0.4)).toBeCloseTo(-1);
    expect(wingWave(0.99999)).toBeCloseTo(1, 3);
    // The downstroke reaches the bottom sooner than the upstroke the top.
    expect(wingWave(0.2)).toBeCloseTo(0);
    expect(wingWave(0.7)).toBeCloseTo(0);
  });
});

describe("a crow's flight", () => {
  it("sits still, folded, until it's told to go", () => {
    const rand = mulberry32(1);
    const bird = perchedBird(A, 1, rand);
    for (let i = 0; i < 600; i++) {
      const p = stepBird(bird, DT, rand);
      expect(p.x).toBe(A.x);
      expect(p.z).toBe(A.z);
      expect(Math.abs(p.y - A.y)).toBeLessThan(0.05);
      // Folded (a ruffle opens them a little, never into flight).
      expect(p.beat).toBeLessThan(0.2);
      expect(p.spread).toBeLessThan(0.9);
    }
    expect(bird.phase).toBe("perched");
  });

  it("gets ready before it goes: turns, crouches, and flaps without moving", () => {
    const { frames } = fly();
    const prep = frames.filter((f) => f.phase === "prep");
    expect(prep.length).toBeGreaterThan(0.4 / DT);
    for (const f of prep) {
      expect(f.x).toBe(A.x);
      expect(f.z).toBe(A.z);
    }
    // The crouch: lower than the perch at some point in the prep.
    expect(Math.min(...prep.map((f) => f.y))).toBeLessThan(A.y - 0.04);
    // And the wings are beating (half-beats) before it leaves.
    expect(Math.max(...prep.map((f) => f.amp))).toBeGreaterThan(0.25);
  });

  it("a startled bird gets ready much faster than a calm one", () => {
    const calm = fly(false).frames.filter((f) => f.phase === "prep").length;
    const startled = fly(true).frames.filter((f) => f.phase === "prep").length;
    expect(startled).toBeLessThan(calm / 2);
    expect(startled * DT).toBeGreaterThan(FLIGHT.startle * 0.9);
  });

  it("speeds up under a limited acceleration, never teleports, and never exceeds cruise", () => {
    const { frames } = fly();
    const flying = frames.filter((f) => f.phase === "flying");
    let lastSpeed = 0;
    for (let i = 1; i < flying.length; i++) {
      const a = flying[i - 1];
      const b = flying[i];
      const accel = (b.speed - a.speed) / DT;
      expect(accel).toBeLessThanOrEqual(FLIGHT.accel + 1e-6);
      expect(accel).toBeGreaterThanOrEqual(-FLIGHT.decel - 1e-6);
      const step = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      expect(step).toBeLessThan((FLIGHT.cruise + FLIGHT.leap) * DT * 1.5);
      expect(b.speed).toBeLessThanOrEqual(FLIGHT.cruise + 1e-6);
      lastSpeed = b.speed;
    }
    // It leaves slowly: well under cruise a quarter second in.
    const early = flying.find((f) => f.t - flying[0].t > 0.25);
    expect(early?.speed).toBeLessThan(FLIGHT.cruise * 0.8);
    expect(lastSpeed).toBeLessThanOrEqual(FLIGHT.landSpeed + 1.5);
  });

  it("brakes in: slow at the end, arriving on the perch exactly", () => {
    const { bird, frames } = fly();
    expect(isPerched(bird)).toBe(true);
    expect(bird.x).toBeCloseTo(B.x, 5);
    expect(bird.y).toBeCloseTo(B.y, 5);
    expect(bird.z).toBeCloseTo(B.z, 5);
    const flying = frames.filter((f) => f.phase === "flying");
    const last = flying[flying.length - 1];
    expect(last.speed).toBeLessThan(FLIGHT.landSpeed + 1.5);
    // It flew a believable length of time for the distance (not
    // instantly, not forever).
    const dist = Math.hypot(B.x - A.x, B.z - A.z);
    const time = flying.length * DT;
    expect(time).toBeGreaterThan(dist / FLIGHT.cruise);
    expect(time).toBeLessThan(dist / 2 + 3);
  });

  it("climbs out, arcs over, and never dips below its perches", () => {
    const { frames } = fly();
    const flying = frames.filter((f) => f.phase === "flying");
    const floor = Math.min(A.y, B.y);
    for (const f of flying) expect(f.y).toBeGreaterThan(floor - 0.1);
    expect(Math.max(...flying.map((f) => f.y))).toBeGreaterThan(A.y + 1.5);
  });

  it("comes in on a shallow glide, never dropping out of the sky", () => {
    const { frames } = fly();
    const flying = frames.filter((f) => f.phase === "flying");
    // Over a fifth of a second, longer than a wingbeat's bob of the body.
    const window = 12;
    let steepest = 0;
    for (let i = window; i < flying.length; i++) {
      const sink = (flying[i - window].y - flying[i].y) / (window * DT);
      steepest = Math.max(steepest, sink);
    }
    expect(steepest).toBeLessThan(4);
  });

  it("flaps fastest at take-off and landing, easier in between", () => {
    const { frames } = fly();
    const flying = frames.filter((f) => f.phase === "flying");
    const first = flying.slice(0, Math.round(0.3 / DT));
    const mid = flying.slice(
      Math.round(flying.length * 0.4),
      Math.round(flying.length * 0.6),
    );
    const end = flying.slice(-Math.round(0.4 / DT));
    const mean = (xs: { rate: number }[]) =>
      xs.reduce((s, f) => s + f.rate, 0) / xs.length;
    expect(mean(first)).toBeGreaterThan(mean(mid) + 4);
    expect(mean(end)).toBeGreaterThan(mean(mid) + 3);
  });

  it("folds its wings back after landing, and sits still on the perch", () => {
    const rand = mulberry32(3);
    const { bird } = fly(false, 3);
    const p = stepBird(bird, DT, rand);
    expect(bird.phase).toBe("perched");
    for (let i = 0; i < 120; i++) stepBird(bird, DT, rand);
    expect(bird.pose.beat).toBeLessThan(0.2);
    expect(bird.pose.spread).toBeLessThan(0.9);
    expect(p.beat).toBeGreaterThanOrEqual(FOLDED - 0.2);
  });

  it("is deterministic for a seed, and frame-rate independent in where it ends up", () => {
    const a = fly(false, 11).frames;
    const b = fly(false, 11).frames;
    expect(a.length).toBe(b.length);
    expect(a[a.length - 1]).toEqual(b[b.length - 1]);
    // At 30 fps it takes about as long.
    const rand = mulberry32(11);
    const bird = perchedBird(A, 11, rand);
    for (let i = 0; i < 30; i++) stepBird(bird, DT, rand);
    startFlight(bird, B, false, rand);
    let t = 0;
    while (!isPerched(bird) || t < 0.5) {
      stepBird(bird, 1 / 30, rand);
      t += 1 / 30;
      if (t > 20) break;
    }
    expect(Math.abs(t - a.length * DT)).toBeLessThan(0.6);
    expect(bird.x).toBeCloseTo(B.x, 5);
  });

  it("refuses new orders while it's going", () => {
    const rand = mulberry32(5);
    const bird = perchedBird(A, 5, rand);
    expect(startFlight(bird, B, false, rand)).toBe(true);
    expect(startFlight(bird, A, false, rand)).toBe(false);
  });
});
