import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { WALK_SPEED } from "./animation.js";
import {
  type CatHost,
  type CatProp,
  catHasCaught,
  catOnProp,
  catToHome,
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

  describe("its herzie's boombox", () => {
    const PROP: CatProp = { x: -1.6, z: 0.2, r: 0.35, top: 0.4 };
    /** A herzie that walks in, stops by its boombox, and stands. */
    function arrive(seed: number) {
      const h = host({ prop: { ...PROP } });
      const s = newCatState(seed);
      h.position.z = -4;
      stepCat(s, h, 0, 1 / 60);
      return { h, s };
    }
    const inside = (s: ReturnType<typeof newCatState>, p: CatProp) =>
      Math.hypot(s.position.x - p.x, s.position.z - p.z) < p.r;
    /** Any of its body (nose to rump) in the prop. */
    const bodyIn = (s: ReturnType<typeof newCatState>, p: CatProp) => {
      for (const f of [-0.42, -0.2, 0, 0.2, 0.42]) {
        const x = s.position.x + Math.sin(s.heading) * f * 1.15;
        const z = s.position.z + Math.cos(s.heading) * f * 1.15;
        if (Math.hypot(x - p.x, z - p.z) < p.r) return true;
      }
      return false;
    };

    it("never walks through it, and gets up on it", () => {
      const seen = { beside: 0, on: 0 };
      for (let seed = 1; seed <= 16; seed++) {
        const { h, s } = arrive(seed);
        const p = h.prop as CatProp;
        for (let t = 0; t < 4 / WALK_SPEED; t += 1 / 60) {
          h.position.z += WALK_SPEED / 60;
          stepCat(s, h, WALK_SPEED, 1 / 60);
          expect(inside(s, p)).toBe(false);
        }
        for (let t = 0; t < 12; t += 1 / 60) {
          stepCat(s, h, 0, 1 / 60);
          if (!catOnProp(s) && s.hop < 0) expect(bodyIn(s, p)).toBe(false);
        }
        if (s.perched) {
          seen.on++;
          expect(s.position.y).toBeCloseTo(p.top, 5);
          expect(inside(s, p)).toBe(true);
        } else if (s.propPlan === "beside") {
          seen.beside++;
          const d = Math.hypot(s.position.x - p.x, s.position.z - p.z);
          expect(d).toBeLessThan(p.r + 0.3);
        }
      }
      // Always up on it, where it can get up.
      expect(seen.on).toBe(16);
    });

    it("hops down and follows when the herzie walks off", () => {
      let tried = 0;
      for (let seed = 1; seed <= 16; seed++) {
        const { h, s } = arrive(seed);
        const p = h.prop as CatProp;
        run(60, 4 / WALK_SPEED, WALK_SPEED, h, s);
        run(60, 12, 0, h, s);
        if (!s.perched) continue;
        tried++;
        // Off it goes, along +x, away from the boombox.
        h.heading = Math.PI / 2;
        let down = false;
        for (let t = 0; t < 6; t += 1 / 60) {
          h.position.x += WALK_SPEED / 60;
          stepCat(s, h, WALK_SPEED, 1 / 60);
          if (!catOnProp(s) && s.hop < 0) {
            down = true;
            expect(inside(s, p)).toBe(false);
          }
        }
        expect(down).toBe(true);
        expect(s.position.y).toBeCloseTo(0, 2);
        expect(flat(s.position, h.position)).toBeLessThan(3.5);
      }
      expect(tried).toBeGreaterThan(0);
    });

    it("gets up on it from between it and the herzie (Home)", () => {
      // Home: the herzie stands still, its cat on its spot (the boombox's
      // side), and the boombox fades in after.
      for (let seed = 1; seed <= 16; seed++) {
        const h = host();
        const s = newCatState(seed);
        run(60, 1.5, 0, h, s);
        h.prop = { ...PROP };
        run(60, 10, 0, h, s);
        expect(s.perched).toBe(true);
      }
    });

    it("gets up on it when Home opens mid-walk, whenever it appears", () => {
      // Walking in Town, then H: the herzie stops where it is and the
      // boombox fades in at its left, a moment later.
      for (const delay of [0, 0.3, 0.6, 1, 1.5, 2.5, 5]) {
        for (let seed = 1; seed <= 8; seed++) {
          const h = host({ clearance: 1.07 });
          const s = newCatState(seed);
          run(60, 3, WALK_SPEED, h, s);
          run(60, delay, 0, h, s);
          // At its left (facing +z, its left is +x), as Home sets it down.
          h.prop = {
            x: h.position.x + 2.1,
            z: h.position.z + 0.1,
            r: 0.33,
            top: 0.64,
          };
          run(60, 10, 0, h, s);
          expect(
            s.perched,
            `delay ${delay}, seed ${seed}: plan ${s.propPlan}`,
          ).toBe(true);
        }
      }
    });

    it("walks round the herzie to get to it from the far side", () => {
      for (const z of [-0.5, 0, 0.5]) {
        for (let seed = 1; seed <= 6; seed++) {
          const h = host({ clearance: 1.07 });
          const s = newCatState(seed);
          stepCat(s, h, 0, 1 / 60);
          // The cat on the herzie's right, the boombox on its left.
          s.position.set(-2.2, 0, z);
          h.prop = { x: 2.1, z: 0.1, r: 0.33, top: 0.64 };
          let inHerzie = false;
          for (let t = 0; t < 14; t += 1 / 60) {
            stepCat(s, h, 0, 1 / 60);
            if (Math.hypot(s.position.x, s.position.z) < 1.07 - 1e-6)
              inHerzie = true;
          }
          expect(inHerzie).toBe(false);
          expect(s.perched, `z ${z}, seed ${seed}: ${s.propPlan}`).toBe(true);
        }
      }
    });

    it("jumps up from behind it, round the back of the herzie, and faces the camera", () => {
      // The camera's toward +z (the boombox's front faces it).
      const facing = 0;
      for (const [cx, cz] of [
        [-2.2, 0],
        [-2, 1],
        [0, -2],
        [1.5, 1.5],
        [2.6, 1.2],
      ]) {
        for (let seed = 1; seed <= 4; seed++) {
          const h = host({ clearance: 1.07 });
          const s = newCatState(seed);
          stepCat(s, h, 0, 1 / 60);
          s.position.set(cx, 0, cz);
          h.prop = { x: 2.1, z: 0.1, r: 0.33, top: 0.64, facing };
          let from: number | null = null;
          let inFront = false;
          for (let t = 0; t < 16; t += 1 / 60) {
            stepCat(s, h, 0, 1 / 60);
            if (s.hop >= 0 && from === null) from = s.hopFrom.z;
            // Never crossing in front of the herzie, between it and the
            // camera (once it's set off).
            if (
              t > 0.5 &&
              Math.abs(s.position.x) < 0.6 &&
              s.position.z > 0.5 &&
              cz <= 0.5
            )
              inFront = true;
          }
          const at = `from (${cx}, ${cz}), seed ${seed}`;
          expect(s.perched, at).toBe(true);
          expect(from, at).not.toBeNull();
          expect(from as number, at).toBeLessThan(0.1);
          expect(inFront, at).toBe(false);
          expect(Math.abs(Math.sin(s.heading - facing)), at).toBeLessThan(0.1);
          expect(Math.cos(s.heading - facing), at).toBeGreaterThan(0);
        }
      }
    });

    /** Walks in Town, then H: the camera's toward +z. Steps it Home,
     * noting whether it went through the herzie, when it got going, and
     * how long till it's up on the boombox (if it has one, set out a
     * moment after). */
    function goHome(
      seed: number,
      from: [number, number] | null,
      prop: boolean,
      rest = 0,
    ) {
      const h = host({ clearance: 1.07, facing: 0 });
      const s = newCatState(seed);
      run(60, 3, WALK_SPEED, h, s);
      if (from)
        s.position.set(h.position.x + from[0], 0, h.position.z + from[1]);
      s.rest = rest;
      catToHome(s, prop);
      let through = false;
      let off = -1;
      let up = -1;
      const start = s.position.clone();
      for (let t = 0; t < 12; t += 1 / 60) {
        if (prop && t > 0.4 && !h.prop)
          h.prop = {
            x: h.position.x + 2.1,
            z: h.position.z + 0.1,
            r: 0.33,
            top: 0.64,
            facing: 0,
          };
        stepCat(s, h, 0, 1 / 60);
        const dx = s.position.x - h.position.x;
        const dz = s.position.z - h.position.z;
        if (Math.hypot(dx, dz) < 1.07 - 1e-6) through = true;
        if (off < 0 && flat(s.position, start) > 0.15) off = t;
        if (s.perched && up < 0) up = t;
      }
      return { h, s, through, off, up };
    }

    it("at Home: hurries straight up on it", () => {
      const froms: ([number, number] | null)[] = [
        null,
        [-2, 0.5],
        [0.5, 2],
        [2.5, 1.5],
        [1, -1.8],
      ];
      for (const from of froms)
        for (let seed = 1; seed <= 4; seed++) {
          const { s, through, off, up } = goHome(seed, from, true);
          const at = `from ${from}, seed ${seed}`;
          expect(through, at).toBe(false);
          expect(s.perched, at).toBe(true);
          // Off as soon as the boombox is out, and up on it soon after.
          expect(off, at).toBeLessThan(1.1);
          expect(up, at).toBeLessThan(4);
        }
    });

    it("at Home: up on it quickly even from lying down", () => {
      for (let seed = 1; seed <= 4; seed++) {
        const { s, up } = goHome(seed, [-2, 0.5], true, 2);
        expect(s.perched, `seed ${seed}`).toBe(true);
        expect(up, `seed ${seed}`).toBeLessThan(4.5);
      }
    });

    it("at Home without one: hurries to lie down beside the herzie", () => {
      for (let seed = 1; seed <= 6; seed++) {
        const { h, s, through, off } = goHome(seed, [0.5, -2], false);
        const at = `seed ${seed}`;
        expect(through, at).toBe(false);
        expect(off, at).toBeLessThan(0.6);
        expect(s.rest, at).toBeGreaterThan(1.9);
        // At its side, not behind or in front.
        const dx = s.position.x - h.position.x;
        const dz = s.position.z - h.position.z;
        expect(Math.abs(dx), at).toBeGreaterThan(1.07);
        expect(Math.abs(dx), at).toBeLessThan(1.8);
        expect(Math.abs(dz), at).toBeLessThan(0.4);
        // Facing the camera.
        expect(Math.cos(s.heading), at).toBeGreaterThan(0.95);
      }
    });

    it("settles beside it when it can't get up", () => {
      // Nowhere to jump from: only a ring of land round it, too narrow
      // for a run-up.
      const p: CatProp = { ...PROP };
      const h = host({
        position: new Vector3(p.x + p.r + 0.6, 0, p.z),
        clearance: 0.1,
        walkable: (x, z) => Math.hypot(x - p.x, z - p.z) < p.r + 0.72,
      });
      const s = newCatState(3);
      stepCat(s, h, 0, 1 / 60);
      s.position.set(p.x, 0, p.z - p.r - 0.5);
      // Set out once it's there.
      h.prop = p;
      run(60, 12, 0, h, s);
      expect(s.propPlan).toBe("beside");
      expect(s.perched).toBe(false);
    });

    it("is back up on it after a long gap (the window shut)", () => {
      const { h, s } = arrive(2);
      run(60, 4 / WALK_SPEED, WALK_SPEED, h, s);
      run(60, 12, 0, h, s);
      expect(s.perched).toBe(true);
      // A long gap, the herzie where it was: as it was.
      stepCat(s, h, 0, 30);
      const p = h.prop as CatProp;
      expect(s.perched).toBe(true);
      expect(s.position.y).toBeCloseTo(p.top, 5);
      expect(Math.hypot(s.position.x - p.x, s.position.z - p.z)).toBeLessThan(
        1e-6,
      );
      // Walked off meanwhile: on the ground, beside the herzie.
      h.position.x += 6;
      stepCat(s, h, WALK_SPEED, 30);
      expect(s.perched).toBe(false);
      expect(s.position.y).toBeCloseTo(0, 5);
    });

    it("looks at the herzie only now and then, and when it sets off", () => {
      const { h, s } = arrive(4);
      run(60, 4 / WALK_SPEED, WALK_SPEED, h, s);
      let watching = 0;
      let frames = 0;
      for (let t = 0; t < 40; t += 1 / 60) {
        stepCat(s, h, 0, 1 / 60);
        frames++;
        if (s.watchFor > 0) watching++;
      }
      expect(watching / frames).toBeGreaterThan(0.05);
      expect(watching / frames).toBeLessThan(0.5);
      s.watchFor = 0;
      stepCat(s, h, WALK_SPEED, 1 / 60);
      expect(s.watchFor).toBeGreaterThan(1);
    });

    it("drops off it if it goes away", () => {
      for (let seed = 1; seed <= 16; seed++) {
        const { h, s } = arrive(seed);
        run(60, 4 / WALK_SPEED, WALK_SPEED, h, s);
        run(60, 12, 0, h, s);
        if (!s.perched) continue;
        h.prop = null;
        run(60, 2, 0, h, s);
        expect(s.perched).toBe(false);
        expect(s.position.y).toBeCloseTo(0, 2);
        return;
      }
      throw new Error("never sat on it");
    });
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
