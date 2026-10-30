import { beforeEach, describe, expect, it } from "vitest";
import { homeMode, resetHomeMode, smoothDamp } from "./homeMode";

const run = (seconds: number, fps = 60) => {
  const steps = Math.round(seconds * fps);
  for (let i = 0; i < steps; i++) homeMode.step(1 / fps);
};

describe("homeMode", () => {
  beforeEach(() => {
    resetHomeMode();
    // The world's up: going Home blends (before that it simply starts there).
    homeMode.setReady(true);
  });

  it("blends in and settles exactly at Home", () => {
    homeMode.set(true);
    run(0.1);
    expect(homeMode.blend).toBeGreaterThan(0);
    expect(homeMode.blend).toBeLessThan(1);
    run(2);
    expect(homeMode.blend).toBe(1);
    expect(homeMode.full).toBe(true);
  });

  it("never overshoots, and only ever rises on the way in", () => {
    homeMode.set(true);
    let last = 0;
    for (let i = 0; i < 120; i++) {
      homeMode.step(1 / 60);
      expect(homeMode.blend).toBeGreaterThanOrEqual(last);
      expect(homeMode.blend).toBeLessThanOrEqual(1);
      last = homeMode.blend;
    }
  });

  it("turns back from halfway smoothly, without jumping", () => {
    homeMode.set(true);
    run(0.2);
    const mid = homeMode.blend;
    homeMode.set(false);
    homeMode.step(1 / 60);
    // Still carried a little further by its speed, or turning: never a jump.
    expect(Math.abs(homeMode.blend - mid)).toBeLessThan(0.05);
    run(2);
    expect(homeMode.blend).toBe(0);
  });

  it("is the same at any frame rate", () => {
    homeMode.set(true);
    run(1 / 3, 30);
    const at30 = homeMode.blend;
    resetHomeMode();
    homeMode.setReady(true);
    homeMode.set(true);
    run(1 / 3, 144);
    expect(Math.abs(homeMode.blend - at30)).toBeLessThan(0.02);
  });

  it("orders its fades: shade first, then the world, accessories last", () => {
    homeMode.set(true);
    run(0.08);
    // Early: the shade is going before the world starts to.
    expect(homeMode.aoFade).toBeGreaterThan(homeMode.worldFade);
    run(2);
    expect(homeMode.aoFade).toBe(1);
    expect(homeMode.worldFade).toBe(1);
    expect(homeMode.accessories).toBe(1);
  });

  it("counts each visit, and asks the shell to leave", () => {
    const reasons: string[] = [];
    const off = homeMode.onExitRequest((r) => reasons.push(r));
    homeMode.requestExit("move");
    expect(reasons).toEqual([]); // not at Home: nothing to leave
    homeMode.set(true);
    expect(homeMode.visit).toBe(1);
    homeMode.requestExit("move");
    expect(reasons).toEqual(["move"]);
    homeMode.set(false);
    homeMode.set(true);
    expect(homeMode.visit).toBe(2);
    off();
  });

  it("starts at Home, no blend, while the world's still loading", () => {
    resetHomeMode();
    homeMode.set(true);
    expect(homeMode.blend).toBe(1);
    homeMode.setReady(true);
    expect(homeMode.blend).toBe(1);
  });
});

describe("smoothDamp", () => {
  it("reaches its target without passing it", () => {
    let s = { value: 0, velocity: 0 };
    for (let i = 0; i < 600; i++) {
      s = smoothDamp(s.value, 1, s.velocity, 0.3, 1 / 60);
      expect(s.value).toBeLessThanOrEqual(1);
    }
    expect(s.value).toBeCloseTo(1, 4);
  });
});
