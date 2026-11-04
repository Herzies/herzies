import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { WALK_SPEED } from "./animation.js";
import {
  type CatHost,
  catHasCaught,
  newCatState,
  REST_LIE,
  REST_SIT,
  REST_SLEEP,
  stepCat,
} from "./cat.js";

function host(overrides: Partial<CatHost> = {}): CatHost {
  return {
    position: new Vector3(),
    heading: 0,
    scale: 1,
    clearance: 0.9,
    ...overrides,
  };
}

/** Runs `seconds` at `fps`, the herzie walking along +z at `speed`. */
function run(
  fps: number,
  seconds: number,
  speed = 0,
  h = host(),
  s = newCatState(1),
) {
  if (!s.started) stepCat(s, h, 0, 1 / fps);
  const dt = 1 / fps;
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    h.position.z += speed * dt;
    stepCat(s, h, speed, dt);
  }
  return { s, h };
}

const flat = (a: Vector3, b: Vector3) => Math.hypot(a.x - b.x, a.z - b.z);

describe("stepCat", () => {
  it("starts on its spot beside the herzie, standing", () => {
    const { s, h } = run(60, 0);
    expect(s.started).toBe(true);
    const d = flat(s.position, h.position);
    expect(d).toBeGreaterThan(h.clearance);
    expect(d).toBeLessThan(h.clearance + 2);
    expect(s.rest).toBe(0);
  });

  it("keeps up with a walking herzie, and walks forward (no strafing)", () => {
    const { s, h } = run(60, 6, WALK_SPEED);
    expect(flat(s.position, h.position)).toBeLessThan(3.5);
    // Facing roughly the way it's going (+z).
    expect(Math.abs(Math.sin(s.heading))).toBeLessThan(0.5);
    expect(Math.cos(s.heading)).toBeGreaterThan(0);
    expect(s.following).toBe(true);
    expect(s.moving).toBeGreaterThan(0.5);
  });

  it("is much the same at 20fps as at 120fps", () => {
    const a = run(120, 5, WALK_SPEED).s;
    const b = run(20, 5, WALK_SPEED).s;
    expect(flat(a.position, b.position)).toBeLessThan(0.35);
  });

  it("advances its gait by distance, not time", () => {
    // Standing still for a while: the gait doesn't tick on.
    const still = run(60, 2).s;
    const before = still.phase;
    run(60, 2, 0, host(), still);
    expect(still.phase).toBeCloseTo(before, 3);
  });

  it("settles down the longer the herzie stands still", () => {
    const { s, h } = run(60, 2, WALK_SPEED);
    run(60, 8, 0, h, s);
    expect(s.following).toBe(false);
    expect(s.rest).toBeGreaterThan(REST_SIT - 0.15);
    run(60, 20, 0, h, s);
    expect(s.rest).toBeGreaterThan(REST_LIE - 0.15);
    h.afk = true;
    run(60, 15, 0, h, s);
    expect(s.rest).toBeGreaterThan(REST_SLEEP - 0.15);
  });

  it("gets up and follows once the herzie walks off", () => {
    const { s, h } = run(60, 10);
    expect(s.rest).toBeGreaterThan(0.8);
    run(60, 4, WALK_SPEED, h, s);
    expect(s.rest).toBeLessThan(0.1);
    expect(s.following).toBe(true);
    expect(flat(s.position, h.position)).toBeLessThan(5);
  });

  it("never walks onto water", () => {
    // Water to the herzie's right (x < −1), where its spot is: the herzie
    // walks up the shore.
    const h = host({ walkable: (x) => x > -1 });
    const s = newCatState(3);
    stepCat(s, h, 0, 1 / 60);
    for (let i = 0; i < 600; i++) {
      h.position.z += WALK_SPEED / 60;
      stepCat(s, h, WALK_SPEED, 1 / 60);
      expect(s.position.x).toBeGreaterThan(-1.05);
    }
    // And it kept up, on the dry side.
    expect(flat(s.position, h.position)).toBeLessThan(4);
  });

  it("stands on the ground under it", () => {
    const h = host({ groundAt: (x, z) => 0.1 * x + 0.05 * z });
    const { s } = run(60, 3, 0, h);
    expect(s.position.y).toBeCloseTo(
      0.1 * s.position.x + 0.05 * s.position.z,
      2,
    );
  });

  it("comes back in from out of sight after a teleport", () => {
    const { s, h } = run(60, 1);
    h.position.set(100, 0, 100);
    stepCat(s, h, 0, 1 / 60);
    const d = flat(s.position, h.position);
    expect(d).toBeGreaterThan(5);
    expect(d).toBeLessThan(9);
    expect(s.following).toBe(true);
    run(60, 4, 0, h, s);
    expect(flat(s.position, h.position)).toBeLessThan(3);
  });

  it("fetches: runs to the item, pounces, and holds it until called back", () => {
    const { s, h } = run(60, 1);
    s.target = new Vector3(6, 0, 4);
    let caughtAt = -1;
    for (let i = 0; i < 600 && caughtAt < 0; i++) {
      stepCat(s, h, 0, 1 / 60);
      if (catHasCaught(s)) caughtAt = i;
    }
    expect(caughtAt).toBeGreaterThan(0);
    // It's at the item: its nose on it.
    expect(flat(s.position, s.target)).toBeLessThan(1.1);
    s.target = null;
    run(60, 4, 0, h, s);
    expect(s.fetch).toBe("none");
    expect(flat(s.position, h.position)).toBeLessThan(3);
  });

  it("walks behind a walking herzie, on its path", () => {
    const { s, h } = run(60, 5, WALK_SPEED);
    // Behind (toward −z), close to the line the herzie walked (x = 0).
    expect(s.position.z).toBeLessThan(h.position.z - h.clearance);
    expect(Math.abs(s.position.x)).toBeLessThan(0.6);
  });

  it("follows the herzie's footsteps round a block, never cutting through", () => {
    // A block the herzie walks round: up, across, back down.
    const inBlock = (x: number, z: number) =>
      x > 1.2 && x < 4.8 && z > -2 && z < 6;
    const h = host({ walkable: (x, z) => !inBlock(x, z) });
    const s = newCatState(5);
    stepCat(s, h, 0, 1 / 60);
    const legs: [number, number, number][] = [
      [0, 1, 8 / WALK_SPEED],
      [1, 0, 6 / WALK_SPEED],
      [0, -1, 8 / WALK_SPEED],
    ];
    for (const [dx, dz, secs] of legs) {
      h.heading = Math.atan2(dx, dz);
      for (let t = 0; t < secs; t += 1 / 60) {
        h.position.x += dx * WALK_SPEED * (1 / 60);
        h.position.z += dz * WALK_SPEED * (1 / 60);
        stepCat(s, h, WALK_SPEED, 1 / 60);
        expect(inBlock(s.position.x, s.position.z)).toBe(false);
      }
    }
    run(60, 3, 0, h, s);
    expect(flat(s.position, h.position)).toBeLessThan(3);
  });

  it("moves up beside the herzie once it stops, if there's room", () => {
    const { s, h } = run(60, 3, WALK_SPEED);
    run(60, 3, 0, h, s);
    // Level with it (not behind), off to one side.
    expect(Math.abs(s.position.z - h.position.z)).toBeLessThan(0.5);
    expect(Math.abs(s.position.x)).toBeGreaterThan(h.clearance);
  });

  it("stays behind when there's no room beside", () => {
    // A narrow lane along x = 0.
    const h = host({ walkable: (x) => Math.abs(x) < 0.9 });
    const { s } = run(60, 3, WALK_SPEED, h);
    run(60, 3, 0, h, s);
    expect(s.position.z).toBeLessThan(h.position.z - h.clearance);
    expect(Math.abs(s.position.x)).toBeLessThan(0.9);
  });

  it("gives up and reappears back along the path when it can't get on", () => {
    const { s, h } = run(60, 2, WALK_SPEED);
    // Dropped somewhere it can't move from.
    s.position.set(-12, 0, h.position.z);
    h.walkable = (x) => x > -11;
    run(60, 4, 0, h, s);
    expect(s.position.x).toBeGreaterThan(-11);
    expect(flat(s.position, h.position)).toBeLessThan(4);
  });

  it("is quick off the mark when the herzie sprints off from a sit", () => {
    const { s, h } = run(60, 8);
    expect(s.rest).toBeGreaterThan(0.8);
    const SPRINT = 6;
    let movingAt = -1;
    let worst = 0;
    for (let i = 0; i < 360; i++) {
      h.position.z += SPRINT / 60;
      stepCat(s, h, SPRINT, 1 / 60);
      if (movingAt < 0 && s.speed > 2) movingAt = i / 60;
      if (i > 120) worst = Math.max(worst, flat(s.position, h.position));
    }
    // Running within about half a second, and not left behind.
    expect(movingAt).toBeGreaterThan(0);
    expect(movingAt).toBeLessThan(0.6);
    expect(worst).toBeLessThan(4);
  });

  it("allocates nothing per step", () => {
    const { s, h } = run(60, 1, WALK_SPEED);
    const pos = s.position;
    const tail = s.tailYaw;
    run(60, 1, WALK_SPEED, h, s);
    expect(s.position).toBe(pos);
    expect(s.tailYaw).toBe(tail);
  });
});
