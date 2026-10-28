import { describe, expect, it } from "vitest";
import {
  buildCloakRig,
  type CloakColliders,
  type CloakInput,
  type CloakRig,
  type CloakSim,
  COLLIDER_STRIDE,
  cloakSurface,
  createCloakSim,
  isCloakSettled,
  pushOutOfColliders,
  resetCloak,
  settleCloak,
  stepCloak,
  type V3,
} from "./cloak-physics.js";
import {
  CLOAK_STYLES,
  type CloakStyle,
  cloakBodyOf,
  cloakColliderParts,
  cloakColliders,
} from "./cloaks.js";
import {
  buildCreatureModel,
  type CreatureMotion,
  creaturePoseOffsets,
  type Sphere,
} from "./creature-renderer.js";

/** A stage-3 herzie in a cloak, and what moves it. */
function setup(
  styleId = "troubadour-mantle",
  seed = "HERZ-CLOAK",
): {
  spheres: Sphere[];
  rig: CloakRig;
  sim: CloakSim;
  style: CloakStyle;
  feet: number;
  posed: (motion: CreatureMotion) => {
    colliders: CloakColliders;
    /** At the arms' full, drawn size. */
    drawn: CloakColliders;
    offset: V3;
  };
} {
  const { spheres } = buildCreatureModel(seed, 3, {});
  let feet = Number.NEGATIVE_INFINITY;
  for (const s of spheres) {
    if (s.zone !== "wearable") feet = Math.max(feet, s.center[1] + s.radius);
  }
  const body = cloakBodyOf(spheres, feet);
  if (!body) throw new Error("no body");
  const parts = cloakColliderParts(spheres);
  const style = CLOAK_STYLES[styleId];
  const rig = buildCloakRig(style.shape, body.cloakBody);
  const atRest = cloakColliders(
    spheres,
    parts,
    body.headAt,
    body.bodyAt,
    (i) => spheres[i].center as V3,
  );
  settleCloak(rig, atRest, feet, style.config);
  const posed = (motion: CreatureMotion) => {
    const d = creaturePoseOffsets(spheres, 3, motion);
    const at = (i: number): V3 => [
      spheres[i].center[0] + d[i][0],
      spheres[i].center[1] + d[i][1],
      spheres[i].center[2] + d[i][2],
    ];
    return {
      colliders: cloakColliders(spheres, parts, body.headAt, body.bodyAt, at),
      drawn: cloakColliders(
        spheres,
        parts,
        body.headAt,
        body.bodyAt,
        at,
        undefined,
        1,
      ),
      offset: d[body.bodyAt] as V3,
    };
  };
  return { spheres, rig, sim: createCloakSim(rig), style, feet, posed };
}

const STILL: CreatureMotion = { idleFrame: 0, walkPhase: 0, walkWeight: 0 };

function input(
  over: Partial<CloakInput> & Pick<CloakInput, "colliders" | "ground">,
): CloakInput {
  return {
    offset: [0, 0, 0],
    accel: [0, 0, 0],
    turnRate: 0,
    velocity: [0, 0, 0],
    ...over,
  };
}

/** The hem's middle. */
function hem(rig: CloakRig, pos: Float32Array): V3 {
  const i = ((rig.rows - 1) * rig.cols + (rig.cols >> 1)) * 3;
  return [pos[i], pos[i + 1], pos[i + 2]];
}

/** How far inside the deepest collider any point of `points` is (0: none
 * is). */
function deepest(points: Float32Array, colliders: CloakColliders): number {
  let worst = 0;
  for (let p = 0; p < points.length; p += 3) {
    for (let o = 0; o < colliders.length; o += COLLIDER_STRIDE) {
      const ax = colliders[o];
      const ay = colliders[o + 1];
      const az = colliders[o + 2];
      const bx = colliders[o + 3] - ax;
      const by = colliders[o + 4] - ay;
      const bz = colliders[o + 5] - az;
      const ll = bx * bx + by * by + bz * bz;
      let t =
        ll > 1e-12
          ? ((points[p] - ax) * bx +
              (points[p + 1] - ay) * by +
              (points[p + 2] - az) * bz) /
            ll
          : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(
        points[p] - (ax + bx * t),
        points[p + 1] - (ay + by * t),
        points[p + 2] - (az + bz * t),
      );
      worst = Math.max(worst, colliders[o + 6] - d);
    }
  }
  return worst;
}

/** The largest stretch of any along-thread, as a fraction of its length. */
function worstStretch(rig: CloakRig, pos: Float32Array): number {
  let worst = 0;
  for (let k = 0; k < rig.kinds.length; k++) {
    if (rig.kinds[k] !== 0) continue;
    const a = rig.pairs[k * 2];
    const b = rig.pairs[k * 2 + 1];
    const l = Math.hypot(
      pos[b * 3] - pos[a * 3],
      pos[b * 3 + 1] - pos[a * 3 + 1],
      pos[b * 3 + 2] - pos[a * 3 + 2],
    );
    worst = Math.max(worst, l / rig.lengths[k] - 1);
  }
  return worst;
}

describe("cloak physics", () => {
  it("hangs down the back from a collar under the head, clear of the body", () => {
    const { rig, posed } = setup();
    const { colliders } = posed(STILL);
    const collar = [rig.rest[(rig.cols >> 1) * 3 + 1]];
    const [, hy, hz] = hem(rig, rig.rest);
    // Down from the collar, behind the herzie (+z).
    expect(hy).toBeGreaterThan(collar[0] + 0.8);
    expect(hz).toBeGreaterThan(0.3);
    expect(deepest(rig.rest, colliders)).toBeLessThan(0.005);
  });

  it("settles still, and goes to sleep so a still view can stop drawing", () => {
    const { rig, sim, posed, style, feet } = setup();
    const { colliders } = posed(STILL);
    for (let f = 0; f < 120; f++) {
      stepCloak(
        sim,
        rig,
        1 / 60,
        input({ colliders, ground: feet }),
        style.config,
      );
    }
    expect(isCloakSettled(sim)).toBe(true);
  });

  it("billows back walking, more running, and calms to sleep after stopping", () => {
    const run = (speed: number) => {
      const { rig, sim, posed, style, feet } = setup();
      for (let f = 0; f < 120; f++) {
        const t = f / 60;
        const { colliders, offset } = posed({
          idleFrame: 0,
          walkPhase: (t * speed) / 2.4,
          walkWeight: 1,
        });
        stepCloak(
          sim,
          rig,
          1 / 60,
          input({ colliders, offset, ground: feet, velocity: [0, 0, -speed] }),
          style.config,
        );
      }
      const lift = hem(rig, sim.pos)[2] - hem(rig, rig.rest)[2];
      // Stop, and wait.
      const { colliders } = posed(STILL);
      let settledAt = Number.POSITIVE_INFINITY;
      for (let f = 0; f < 360; f++) {
        stepCloak(
          sim,
          rig,
          1 / 60,
          input({ colliders, ground: feet }),
          style.config,
        );
        if (isCloakSettled(sim) && settledAt === Number.POSITIVE_INFINITY)
          settledAt = f / 60;
      }
      return { lift, settledAt };
    };
    const walk = run(5);
    const sprint = run(6.7);
    expect(walk.lift).toBeGreaterThan(0.15);
    expect(sprint.lift).toBeGreaterThan(walk.lift);
    expect(walk.settledAt).toBeLessThan(4);
  });

  it("flares out when spun", () => {
    const { rig, sim, posed, style, feet } = setup();
    const { colliders } = posed(STILL);
    for (let f = 0; f < 90; f++) {
      stepCloak(
        sim,
        rig,
        1 / 60,
        input({ colliders, ground: feet, turnRate: 8 }),
        style.config,
      );
    }
    const rest = hem(rig, rig.rest);
    const spun = hem(rig, sim.pos);
    // Flung outward from the axis it turns about.
    expect(Math.hypot(spun[0], spun[2])).toBeGreaterThan(
      Math.hypot(rest[0], rest[2]) + 0.1,
    );
  });

  it("floats up as a jump falls", () => {
    const { rig, sim, posed, style, feet } = setup();
    const { colliders } = posed(STILL);
    // A real hop in creature units (HerzieModel's JUMP_HEIGHT and
    // JUMP_AIR_SECONDS): up at ~10.6/s, falling at ~59/s² (+y is down).
    const g = 58.8;
    const v0 = 10.6;
    const restY = hem(rig, rig.rest)[1];
    let highest = restY;
    for (let t = 0; t < 0.36; t += 1 / 60) {
      stepCloak(
        sim,
        rig,
        1 / 60,
        input({
          colliders,
          ground: feet + 0.85 / 0.893,
          accel: [0, g, 0],
          velocity: [0, -v0 + g * t, 0],
        }),
        style.config,
      );
      highest = Math.min(highest, hem(rig, sim.pos)[1]);
    }
    expect(highest).toBeLessThan(restY - 0.05);
  });

  it("hardly stretches in play, and stays bounded however hard it's yanked", () => {
    for (const id of Object.keys(CLOAK_STYLES)) {
      const { rig, sim, posed, style, feet } = setup(id);
      let seed = 3;
      const rand = () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      };
      let m = { walk: 1, turn: 0, speed: 5, dance: 0 };
      let worst = 0;
      for (let f = 0; f < 600; f++) {
        if (f % 50 === 0) {
          m = {
            walk: rand() < 0.7 ? 1 : 0,
            turn: (rand() - 0.5) * 12,
            speed: 4.5 + rand() * 2.5,
            dance: rand() < 0.2 ? 1 : 0,
          };
        }
        const t = f / 60;
        const { colliders, offset } = posed({
          idleFrame: t * 8,
          walkPhase: (t * m.speed) / 2.4,
          walkWeight: m.walk,
          danceFrame: t * 15,
          danceWeight: m.dance,
        });
        stepCloak(
          sim,
          rig,
          1 / 60,
          input({
            colliders,
            offset,
            ground: feet,
            turnRate: m.turn,
            velocity: [0, 0, -m.speed * m.walk],
            accel: f % 50 < 6 ? [(rand() - 0.5) * 40, 0, -25] : [0, 0, 0],
          }),
          style.config,
        );
        worst = Math.max(worst, worstStretch(rig, sim.pos));
      }
      expect(worst).toBeLessThan(0.04);
    }
    const { rig, sim, posed, style, feet } = setup("tailwind-cloak");
    const { colliders } = posed(STILL);
    for (let f = 0; f < 60; f++) {
      stepCloak(
        sim,
        rig,
        1 / 60,
        input({
          colliders,
          ground: feet,
          accel: [f % 20 < 10 ? 200 : -200, 0, 0],
          velocity: [0, 0, -14],
          turnRate: f % 30 < 15 ? 20 : -20,
        }),
        style.config,
      );
      expect(worstStretch(rig, sim.pos)).toBeLessThan(0.1);
    }
  });

  it("never ends up inside the body, nor does its drawn surface, under anything", {
    timeout: 60_000,
  }, () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    for (const id of Object.keys(CLOAK_STYLES)) {
      const { rig, sim, posed, style, feet } = setup(id, `HERZ-${id}`);
      const sub = 3;
      const rc = (rig.cols - 1) * sub + 1;
      const rr = (rig.rows - 1) * sub + 1;
      const surface = new Float32Array(rc * rr * 3);
      const scratch = new Float32Array(rig.rows * rc * 3);
      let t = 0;
      let motion = { walk: 0, dance: 0, sit: 0, cast: -1, turn: 0, speed: 0 };
      for (let f = 0; f < 900; f++) {
        if (f % 45 === 0) {
          motion = {
            walk: rand() < 0.6 ? 1 : 0,
            dance: rand() < 0.3 ? 1 : 0,
            sit: rand() < 0.15 ? 1 : 0,
            cast: rand() < 0.3 ? 0 : -1,
            turn: (rand() - 0.5) * 16,
            speed: rand() * 7,
          };
        }
        // Frames don't land evenly.
        const dt = (0.5 + rand()) / 60;
        t += dt;
        if (motion.cast >= 0) motion.cast = Math.min(1, motion.cast + dt / 0.4);
        const { colliders, drawn, offset } = posed({
          idleFrame: t * 8,
          walkPhase: (t * motion.speed) / 2.4,
          walkWeight: motion.walk,
          danceFrame: t * 15,
          danceWeight: motion.dance,
          sitWeight: motion.sit,
          castPhase:
            motion.cast >= 0 && motion.cast < 1 ? motion.cast : undefined,
        });
        stepCloak(
          sim,
          rig,
          dt,
          input({
            colliders,
            offset,
            ground: feet,
            turnRate: motion.turn,
            velocity: [0, 0, -motion.speed * motion.walk],
            accel: [
              (rand() - 0.5) * 20,
              (rand() - 0.5) * 10,
              (rand() - 0.5) * 20,
            ],
          }),
          style.config,
        );
        for (const v of sim.pos) expect(Number.isFinite(v)).toBe(true);
        // The particles keep their margin, give or take a sweep's worth (the
        // collar is pinned to the torso: a nodding head can meet it, which
        // the drawn surface's push below takes care of)…
        expect(deepest(sim.pos.subarray(rig.cols * 3), colliders)).toBeLessThan(
          0.01,
        );
        // …and the drawn surface, pushed out once more, never shows inside.
        cloakSurface(sim.pos, rig.cols, rig.rows, sub, surface, scratch);
        // (against the body as drawn: arms at their full size).
        pushOutOfColliders(surface, drawn, 0.02);
        expect(deepest(surface, drawn)).toBeLessThan(1e-4);
      }
    }
  });

  it("is deterministic", () => {
    const run = () => {
      const { rig, sim, posed, style, feet } = setup();
      for (let f = 0; f < 60; f++) {
        const { colliders, offset } = posed({
          idleFrame: f,
          walkPhase: f / 30,
          walkWeight: 1,
        });
        stepCloak(
          sim,
          rig,
          1 / 60,
          input({
            colliders,
            offset,
            ground: feet,
            velocity: [0, 0, -5],
            turnRate: 2,
          }),
          style.config,
        );
      }
      return Array.from(sim.pos);
    };
    expect(run()).toEqual(run());
  });

  it("snaps back to its drape after a teleport", () => {
    const { rig, sim, posed, style, feet } = setup();
    const { colliders } = posed(STILL);
    for (let f = 0; f < 30; f++) {
      stepCloak(
        sim,
        rig,
        1 / 60,
        input({ colliders, ground: feet, velocity: [0, 0, -6], turnRate: 5 }),
        style.config,
      );
    }
    resetCloak(sim, rig, [0, 0.1, 0]);
    expect(hem(rig, sim.pos)[1]).toBeCloseTo(hem(rig, rig.rest)[1] + 0.1, 5);
  });

  it("each hem is cut its own way", () => {
    const tips = (id: string) => {
      const { rig } = setup(id);
      const r = rig.rows - 1;
      const y = (c: number) => rig.rest[(r * rig.cols + c) * 3 + 1];
      return {
        edge: y(0),
        mid: y(rig.cols >> 1),
        next: y((rig.cols >> 1) + 1),
      };
    };
    // Round: longest at the middle. Swallowtail: a notch up the middle.
    expect(tips("troubadour-mantle").mid).toBeGreaterThan(
      tips("troubadour-mantle").edge,
    );
    expect(tips("tailwind-cloak").mid).toBeLessThan(
      tips("tailwind-cloak").edge,
    );
    // Dagged: points and notches side by side.
    const dagged = tips("groove-cape");
    expect(Math.abs(dagged.mid - dagged.next)).toBeGreaterThan(0.05);
  });
});
