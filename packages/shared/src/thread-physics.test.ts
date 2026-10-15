import { describe, expect, it } from "vitest";
import { buildCreatureModel } from "./creature-renderer.js";
import {
  createThreadSim,
  isThreadSettled,
  stepThreadSim,
  type ThreadInput,
  type ThreadRig,
} from "./thread-physics.js";

type V3 = [number, number, number];

function rig(): ThreadRig {
  const { spheres } = buildCreatureModel("thread-test", 3, {
    main_hand: "compact-discs",
  });
  const thread = spheres.find((s) => s.held?.thread)?.held?.thread;
  if (!thread) throw new Error("no thread");
  return thread.rig;
}

const STILL: ThreadInput = { offset: [0, 0, 0], accel: [0, 0, 0], turnRate: 0 };
const dist = (a: V3, b: V3) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Runs it `seconds` at 60 fps, `input` each frame. */
function run(
  sim: ReturnType<typeof createThreadSim>,
  r: ThreadRig,
  seconds: number,
  input: ThreadInput | ((t: number) => ThreadInput),
  each?: () => void,
) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    stepThreadSim(
      sim,
      r,
      1 / 60,
      typeof input === "function" ? input(t) : input,
    );
    each?.();
  }
}

describe("discs on threads", () => {
  it("is built hanging where it settles: still, it stays put", () => {
    const r = rig();
    const sim = createThreadSim(r);
    run(sim, r, 2, STILL);
    sim.pos.forEach((p, i) => {
      expect(dist(p, r.rest[i])).toBeLessThan(1e-3);
    });
    expect(isThreadSettled(sim)).toBe(true);
  });

  it("never stretches a thread, nor lets a disc into the body", () => {
    const r = rig();
    const sim = createThreadSim(r);
    // Lurch about, spin hard, bob.
    for (let t = 0; t < 3; t += 1 / 60) {
      const input: ThreadInput = {
        offset: [0, 0.03 * Math.sin(t * 20), 0],
        accel: [40 * Math.sin(t * 7), 0, 40 * Math.cos(t * 5)],
        turnRate: 8 * Math.sin(t * 3),
      };
      stepThreadSim(sim, r, 1 / 60, input);
      const moved = (v: V3): V3 => [
        v[0] + input.offset[0],
        v[1] + input.offset[1],
        v[2] + input.offset[2],
      ];
      expect(dist(sim.pos[0], moved(r.knot))).toBeLessThanOrEqual(
        r.lengths[0] + 1e-9,
      );
      expect(dist(sim.pos[1], sim.pos[0])).toBeLessThanOrEqual(
        r.lengths[1] + 1e-9,
      );
      // The last word is the threads', so the back may give a hair.
      sim.pos.forEach((p, i) => {
        expect(dist(p, moved(r.center))).toBeGreaterThanOrEqual(
          r.clear[i] * 0.98,
        );
      });
    }
  });

  it("swings on after it stops, the lower disc furthest, then settles", () => {
    const r = rig();
    const sim = createThreadSim(r);
    // Steps off sideways (+x), quickly, then stops dead: they swing across
    // the back.
    run(sim, r, 0.25, { ...STILL, accel: [30, 0, 0] });
    run(sim, r, 0.25, { ...STILL, accel: [-30, 0, 0] });
    let most = [0, 0];
    run(sim, r, 1, STILL, () => {
      most = most.map((m, i) => Math.max(m, dist(sim.pos[i], r.rest[i])));
    });
    expect(most[0]).toBeGreaterThan(0.01);
    expect(most[1]).toBeGreaterThan(most[0]);
    run(sim, r, 8, STILL);
    sim.pos.forEach((p, i) => {
      expect(dist(p, r.rest[i])).toBeLessThan(5e-3);
    });
  });

  it("trails out behind as it walks", () => {
    const r = rig();
    const sim = createThreadSim(r);
    // Walking forward (−z): the air blows them back, off the back (+z).
    run(sim, r, 2, { ...STILL, velocity: [0, 0, -3] });
    expect(sim.pos[1][2]).toBeGreaterThan(r.rest[1][2] + 0.01);
  });

  it("trails a turn", () => {
    const r = rig();
    const sim = createThreadSim(r);
    // Turning positively about creature y carries the back (+z) toward +x:
    // the discs lag, toward −x.
    run(sim, r, 0.3, { ...STILL, turnRate: 6 });
    const [x] = sim.pos[1];
    expect(x - r.rest[1][0]).toBeLessThan(-0.01);
  });
});
