import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { WALK_SPEED } from "./animation.js";
import {
  type CompanionHost,
  newCompanionState,
  springStep,
  stepCompanion,
} from "./companion.js";

function host(overrides: Partial<CompanionHost> = {}): CompanionHost {
  return {
    position: new Vector3(),
    heading: 0,
    scale: 1,
    slot: new Vector3(1.2, 1.5, 0),
    clearance: 1,
    ...overrides,
  };
}

/** Runs `seconds` at `fps`, the herzie walking along +z at `speed`. */
function run(fps: number, seconds: number, speed = 0, seed = 1) {
  const s = newCompanionState(seed);
  const h = host();
  stepCompanion(s, h, 0, 0);
  const dt = 1 / fps;
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    h.position.z += speed * dt;
    stepCompanion(s, h, speed, dt);
  }
  return { s, h };
}

describe("springStep", () => {
  it("settles on its goal", () => {
    let x = 0;
    let v = 0;
    for (let i = 0; i < 600; i++) [x, v] = springStep(x, v, 5, 1, 0.7, 1 / 60);
    expect(x).toBeCloseTo(5, 4);
    expect(v).toBeCloseTo(0, 4);
  });

  it("overshoots a little under-damped, and not at all critically", () => {
    const peak = (damping: number) => {
      let x = 0;
      let v = 0;
      let most = 0;
      for (let i = 0; i < 600; i++) {
        [x, v] = springStep(x, v, 1, 1, damping, 1 / 60);
        most = Math.max(most, x);
      }
      return most;
    };
    expect(peak(0.7)).toBeGreaterThan(1.01);
    expect(peak(0.7)).toBeLessThan(1.1);
    expect(peak(1)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("is the same in one big step as in many small ones", () => {
    let x = 0;
    let v = 2;
    for (let i = 0; i < 10; i++) [x, v] = springStep(x, v, 3, 0.8, 0.6, 0.01);
    const [x1, v1] = springStep(0, 2, 3, 0.8, 0.6, 0.1);
    expect(x1).toBeCloseTo(x, 9);
    expect(v1).toBeCloseTo(v, 9);
  });
});

describe("stepCompanion", () => {
  it("starts on its slot, beside the herzie as it faces", () => {
    const s = newCompanionState();
    const h = host({ heading: Math.PI / 2, position: new Vector3(4, 0, 2) });
    stepCompanion(s, h, 0, 0);
    // Facing +x, the slot's +x side is −z.
    expect(s.position.x).toBeCloseTo(4, 6);
    expect(s.position.y).toBeCloseTo(1.5, 6);
    expect(s.position.z).toBeCloseTo(2 - 1.2, 6);
  });

  it("doesn't move in a step of no time", () => {
    const { s, h } = run(60, 1, WALK_SPEED);
    const at = s.position.clone();
    h.position.z += 1;
    stepCompanion(s, h, WALK_SPEED, 0);
    expect(s.position.equals(at)).toBe(true);
  });

  it("trails behind a walking herzie, and keeps up", () => {
    const { s, h } = run(60, 5, WALK_SPEED);
    const behind = h.position.z - s.position.z;
    expect(behind).toBeGreaterThan(0.3);
    expect(behind).toBeLessThan(3);
    // Matching its pace.
    expect(s.velocity.z).toBeCloseTo(WALK_SPEED, 1);
  });

  it("catches up and settles once the herzie stops", () => {
    const { s, h } = run(60, 3, WALK_SPEED);
    for (let i = 0; i < 60 * 8; i++) stepCompanion(s, h, 0, 1 / 60);
    // Near its slot, give or take its wandering.
    const dx = s.position.x - (h.position.x + 1.2);
    const dz = s.position.z - h.position.z;
    expect(Math.hypot(dx, dz)).toBeLessThan(0.7);
  });

  it("moves the same at any frame rate", () => {
    const at = [20, 60, 144].map((fps) => run(fps, 2, WALK_SPEED).s.position);
    for (const p of at) expect(p.distanceTo(at[1])).toBeLessThan(0.08);
  });

  it("is there at once after a teleport, or a long frame", () => {
    const { s, h } = run(60, 1);
    h.position.set(50, 0, 50);
    stepCompanion(s, h, 0, 1 / 60);
    expect(s.position.distanceTo(new Vector3(51.2, 1.5, 50))).toBeLessThan(
      1e-6,
    );
    h.position.set(0, 0, 3);
    stepCompanion(s, h, 0, 2);
    expect(s.position.distanceTo(new Vector3(1.2, 1.5, 3))).toBeLessThan(1e-6);
  });

  it("never passes through the herzie", () => {
    const s = newCompanionState(3);
    const h = host();
    stepCompanion(s, h, 0, 0);
    // Spinning on the spot swings its slot round the far side.
    for (let i = 0; i < 60 * 6; i++) {
      h.heading += (Math.PI / 60) * 1.5;
      stepCompanion(s, h, 0, 1 / 60);
      const r = Math.hypot(s.position.x, s.position.z);
      expect(r).toBeGreaterThanOrEqual(h.clearance - 1e-9);
    }
  });

  it("wanders about its slot while the herzie stands still", () => {
    const s = newCompanionState(7);
    const h = host();
    stepCompanion(s, h, 0, 0);
    const seen: Vector3[] = [];
    for (let i = 0; i < 60 * 20; i++) {
      stepCompanion(s, h, 0, 1 / 60);
      if (i % 30 === 0) seen.push(s.position.clone());
    }
    let spread = 0;
    for (const p of seen) {
      const d = Math.hypot(p.x - 1.2, p.z);
      expect(d).toBeLessThan(0.7);
      spread = Math.max(spread, d);
    }
    // It does drift, rather than hang there.
    expect(spread).toBeGreaterThan(0.05);
  });

  it("doesn't chase a herzie shuffling on the spot", () => {
    const s = newCompanionState(2);
    const h = host();
    stepCompanion(s, h, 0, 0);
    for (let i = 0; i < 60 * 3; i++) stepCompanion(s, h, 0, 1 / 60);
    const settled = s.position.clone();
    // A step of 0.2, then still: inside the deadzone.
    h.position.x += 0.2;
    for (let i = 0; i < 30; i++) stepCompanion(s, h, 0, 1 / 60);
    // Moved no more than its own wandering would.
    expect(s.position.distanceTo(settled)).toBeLessThan(0.3);
  });

  it("faces where it flies, and leans into it", () => {
    const s = newCompanionState();
    const h = host();
    stepCompanion(s, h, 0, 0);
    let leaned = 0;
    for (let i = 0; i < 40; i++) {
      h.position.z += WALK_SPEED / 60;
      stepCompanion(s, h, WALK_SPEED, 1 / 60);
      leaned = Math.max(leaned, s.pitch);
    }
    expect(Math.cos(s.heading)).toBeGreaterThan(0.9);
    expect(leaned).toBeGreaterThan(0.02);
    expect(leaned).toBeLessThanOrEqual(0.22);
  });

  it("grows with the herzie", () => {
    const s = newCompanionState();
    const h = host({ scale: 2 });
    stepCompanion(s, h, 0, 0);
    expect(s.position.x).toBeCloseTo(2.4, 6);
    expect(s.position.y).toBeCloseTo(3, 6);
  });
});
