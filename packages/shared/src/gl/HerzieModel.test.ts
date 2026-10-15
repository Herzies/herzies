import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildCreatureModel, type Sphere } from "../creature-renderer.js";
import { DEFAULT_THREAD_CONFIG } from "../thread-physics.js";
import { WALK_SPEED } from "./animation.js";
import {
  CAST_RELEASE_SECONDS,
  CAST_SECONDS,
  DRAW_SECONDS,
  HerzieModel,
  HITSTOP_SECONDS,
  MODEL_SCALE,
  SHEATHE_DELAY,
  SHEATHE_SECONDS,
} from "./HerzieModel.js";

const LOOK = { seed: "model-test", stage: 3, equipped: { head: "headphones" } };

function bounds(h: HerzieModel) {
  h.root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  // The shadow is a flat disc on the ground; measure the body alone.
  for (const child of h.root.children) {
    if (child instanceof THREE.Group) box.expandByObject(child);
  }
  return box;
}

describe("HerzieModel", () => {
  it("is shaded by the sun's shadow alone, not the lamps'", () => {
    const h = new HerzieModel(LOOK);
    let shader = "";
    h.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.ShaderMaterial)
        shader = o.material.fragmentShader;
    });
    // getShadowMask() multiplies in every light's shadow.
    expect(shader).not.toContain("getShadowMask(");
    expect(shader).toContain("directionalShadowMap");
  });

  it("bounds every part, scenery too, at any turn", () => {
    const h = new HerzieModel(
      {
        seed: "model-test",
        stage: 3,
        equipped: { head: "witch-hat", ground_left: "boombox" },
      },
      { anchorScenery: 0 },
    );
    for (const heading of [0, 1, 2.5, 4]) {
      h.heading = heading;
      h.update(1 / 60, 0);
      h.root.updateMatrixWorld(true);
      h.root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.computeBoundingSphere();
        const part = o.geometry.boundingSphere
          ?.clone()
          .applyMatrix4(o.matrixWorld);
        if (!part) return;
        expect(
          h.bounds.center.distanceTo(part.center) + part.radius,
        ).toBeLessThanOrEqual(h.bounds.radius);
      });
    }
  });

  it("sits down on its bottom, and stands back up", () => {
    const h = new HerzieModel(LOOK);
    h.update(1 / 60, 0);
    const standing = bounds(h);
    h.sitting = true;
    for (let i = 0; i < 60; i++) h.update(1 / 60, 0);
    const seated = bounds(h);
    // Still resting on the root (now its bottom), and lower.
    expect(seated.min.y).toBeCloseTo(0, 1);
    expect(seated.max.y).toBeLessThan(standing.max.y - 0.1);
    h.sitting = false;
    for (let i = 0; i < 60; i++) h.update(1 / 60, 0);
    expect(bounds(h).max.y).toBeCloseTo(standing.max.y, 1);
  });

  it("stands on the ground", () => {
    const box = bounds(new HerzieModel(LOOK));
    expect(box.min.y).toBeCloseTo(0, 1);
  });

  it("is as tall as its parts, scaled into the world", () => {
    const h = new HerzieModel(LOOK);
    const { spheres } = buildCreatureModel(LOOK.seed, 3, LOOK.equipped);
    const body = spheres.filter((s) => s.part !== "spirit" && s.part !== "pet");
    const top = Math.min(...body.map((s) => s.center[1] - s.radius));
    const feet = Math.max(...body.map((s) => s.center[1] + s.radius));
    expect(h.height).toBeCloseTo((feet - top) * MODEL_SCALE, 6);
    // Breathing squash aside, the drawn body matches.
    expect(bounds(h).max.y / h.height).toBeGreaterThan(0.95);
    expect(bounds(h).max.y / h.height).toBeLessThan(1.05);
  });

  it("faces along its heading", () => {
    for (const heading of [0, Math.PI / 2, 2]) {
      const h = new HerzieModel(LOOK);
      h.heading = heading;
      h.update(0, 0);
      h.root.updateMatrixWorld(true);
      // The eyes are on the front: the side the heading points to.
      const eyes = new THREE.Vector3();
      let n = 0;
      h.root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const m = o.material as THREE.ShaderMaterial;
        const shades = m.uniforms?.uShades?.value as THREE.Color[] | undefined;
        if (
          shades?.[0].getHexString() !==
          new THREE.Color("#FFF8DC").getHexString()
        )
          return;
        eyes.add(o.getWorldPosition(new THREE.Vector3()));
        n++;
      });
      expect(n).toBeGreaterThan(0);
      eyes.divideScalar(n);
      const forward = new THREE.Vector2(Math.sin(heading), Math.cos(heading));
      expect(new THREE.Vector2(eyes.x, eyes.z).dot(forward)).toBeGreaterThan(
        0.1,
      );
    }
  });

  it("keeps a ground prop in the same spot on either side, mirrored", () => {
    // As HerzieView builds it: props placed in the window's grid, held
    // still while the herzie turns.
    const options = { layoutCols: 105, layoutRows: 40, anchorScenery: 0 };
    const prop = (side: "ground_left" | "ground_right") => {
      const h = new HerzieModel(
        { ...LOOK, equipped: { [side]: "boombox" } },
        options,
      );
      h.root.updateMatrixWorld(true);
      // The anchored parts are the root's second group (the first turns).
      const groups = h.root.children.filter((c) => c instanceof THREE.Group);
      return new THREE.Box3()
        .setFromObject(groups[1])
        .getCenter(new THREE.Vector3());
    };
    const left = prop("ground_left");
    const right = prop("ground_right");
    expect(left.x).toBeLessThan(0);
    expect(right.x).toBeCloseTo(-left.x, 6);
    expect(right.y).toBeCloseTo(left.y, 6);
    expect(right.z).toBeCloseTo(left.z, 6);
  });

  describe("what dangles", () => {
    const CHAIN = {
      seed: "model-test",
      stage: 3,
      equipped: { body: "gold-chain" },
    };
    const swing = (h: HerzieModel) =>
      (h as unknown as { dangle?: { swing: number } }).dangle?.swing ?? 0;
    /** Turns it by `by` over a few frames, then lets it hang. */
    function turn(h: HerzieModel, from: number, by: number) {
      h.heading = from;
      h.update(1 / 60, 0);
      for (let i = 1; i <= 6; i++) {
        h.heading = from + (by * i) / 6;
        h.update(1 / 60, 0);
      }
    }

    it("swings when it turns, then settles", () => {
      const h = new HerzieModel(CHAIN);
      turn(h, 0, 1.2);
      expect(h.dangleSettled).toBe(false);
      expect(Math.abs(swing(h))).toBeGreaterThan(0.05);
      for (let i = 0; i < 180; i++) h.update(1 / 60, 0);
      expect(h.dangleSettled).toBe(true);
      expect(swing(h)).toBe(0);
    });

    it("doesn't fling the chain when the heading wraps round", () => {
      const h = new HerzieModel(CHAIN);
      h.heading = Math.PI - 0.01;
      h.update(1 / 60, 0);
      h.heading = -Math.PI + 0.01;
      h.update(1 / 60, 0);
      expect(Math.abs(swing(h))).toBeLessThan(0.05);
    });

    it("doesn't swing where it's first put", () => {
      const h = new HerzieModel(CHAIN);
      h.heading = 2.5;
      h.update(1 / 60, 0);
      expect(h.dangleSettled).toBe(true);
    });

    it("turns the witch hat's bent tip with its swing", () => {
      const h = new HerzieModel({
        seed: "model-test",
        stage: 3,
        equipped: { head: "witch-hat" },
      });
      const tips = () =>
        (h as unknown as { meshes: THREE.Mesh[] }).meshes
          .filter((m) => m.geometry instanceof THREE.CylinderGeometry)
          .map((m) => m.quaternion.clone());
      const rest = tips();
      expect(rest.length).toBeGreaterThan(1);
      turn(h, 0, 1.2);
      const swung = tips();
      // The crown stays upright; the bent segments above it turn.
      expect(swung[0].angleTo(rest[0])).toBeCloseTo(0, 6);
      expect(
        swung.at(-1)?.angleTo(rest.at(-1) as THREE.Quaternion),
      ).toBeGreaterThan(0.01);
    });

    it("holds still when told to, or with nothing dangling", () => {
      const held = new HerzieModel(CHAIN);
      held.dangles = false;
      turn(held, 0, 1.2);
      expect(held.dangleSettled).toBe(true);
      const bare = new HerzieModel(LOOK);
      turn(bare, 0, 1.2);
      expect(bare.dangleSettled).toBe(true);
    });
  });

  describe("a spirit in the Town", () => {
    const SPIRIT = { ...LOOK, equipped: { spirit: "spirit-orb" } };
    /** Where the Spirit Orb's core (its biggest part) is, in the world. */
    function spiritAt(h: HerzieModel) {
      h.root.updateMatrixWorld(true);
      const { spheres } = buildCreatureModel(SPIRIT.seed, 3, SPIRIT.equipped);
      const core = Math.max(
        ...spheres.filter((s) => s.part === "spirit").map((s) => s.radius),
      );
      const at: THREE.Vector3[] = [];
      h.root.traverse((o) => {
        if (o instanceof THREE.Mesh && o.scale.x === core)
          at.push(o.getWorldPosition(new THREE.Vector3()));
      });
      expect(at).toHaveLength(1);
      return at[0];
    }

    it("starts beside the herzie, clear of it, off the ground", () => {
      const h = new HerzieModel(SPIRIT);
      h.update(0, 0);
      const at = spiritAt(h);
      expect(Math.hypot(at.x, at.z)).toBeGreaterThan(0.5);
      expect(at.y).toBeGreaterThan(0.5);
      expect(at.y).toBeLessThan(h.height + 1);
    });

    it("follows the herzie on its own, rather than riding on it", () => {
      const h = new HerzieModel(SPIRIT);
      h.update(0, 0);
      const start = spiritAt(h);
      // The herzie jumps a step forward: the spirit lags, then follows.
      h.root.position.z += 1;
      h.update(1 / 60, WALK_SPEED);
      expect(spiritAt(h).z - start.z).toBeLessThan(0.2);
      for (let i = 0; i < 60 * 4; i++) h.update(1 / 60, 0);
      expect(spiritAt(h).z - start.z).toBeGreaterThan(0.5);
    });

    it("doesn't snap round when the herzie turns", () => {
      const h = new HerzieModel(SPIRIT);
      h.update(0, 0);
      const start = spiritAt(h);
      h.heading = Math.PI;
      h.update(1 / 60, 0);
      expect(spiritAt(h).distanceTo(start)).toBeLessThan(0.2);
    });

    it("rides along unchanged where scenery is anchored", () => {
      const h = new HerzieModel(SPIRIT, { anchorScenery: 0 });
      h.update(0, 0);
      const start = spiritAt(h);
      h.root.position.z += 1;
      h.update(1 / 60, 0);
      expect(spiritAt(h).z - start.z).toBeCloseTo(1, 1);
    });
    for (const spirit of ["spirit-orb", "ghost"]) {
      it(`${spirit} faces and leans the way it flies`, () => {
        const equipped = { spirit };
        const h = new HerzieModel({ ...LOOK, equipped });
        const { spheres } = buildCreatureModel(LOOK.seed, 3, equipped);
        const parts = spheres.filter(
          (s) => s.part === "spirit" || s.part === "pet",
        );
        const core = Math.max(...parts.map((s) => s.radius));
        // Its features: the smallest parts (eyes, pupils, a mouth).
        const feature = Math.min(...parts.map((s) => s.radius)) * 2.01;
        let coreMesh: THREE.Mesh | undefined;
        h.root.traverse((o) => {
          if (o instanceof THREE.Mesh && o.scale.x === core) coreMesh = o;
        });
        // core mesh → its creature space → facing → yaw (turns and leans).
        const yaw = coreMesh?.parent?.parent?.parent as THREE.Object3D;
        h.update(0, 0);
        const up = new THREE.Vector3();
        for (let i = 0; i < 120; i++) {
          h.root.position.z += WALK_SPEED / 60;
          h.update(1 / 60, WALK_SPEED);
          if (i === 10) {
            up.set(0, 1, 0).applyQuaternion(
              yaw.getWorldQuaternion(new THREE.Quaternion()),
            );
          }
        }
        // Leaning into the start, forward rather than sideways.
        expect(up.z).toBeGreaterThan(0.02);
        expect(Math.abs(up.x)).toBeLessThan(up.z / 2);

        h.root.updateMatrixWorld(true);
        const at = (coreMesh as THREE.Mesh).getWorldPosition(
          new THREE.Vector3(),
        );
        const front = new THREE.Vector3();
        let n = 0;
        yaw.traverse((o) => {
          if (o instanceof THREE.Mesh && o.scale.x <= feature) {
            front.add(o.getWorldPosition(new THREE.Vector3()));
            n++;
          }
        });
        expect(n).toBeGreaterThan(0);
        // Its face is toward +z, the way it's flying (not off at an angle).
        front.divideScalar(n).sub(at);
        expect(front.z).toBeGreaterThan(0);
        expect(Math.abs(front.x)).toBeLessThan(front.z * Math.tan(0.35));
      });
    }
  });
});

describe("casting", () => {
  /** Runs it in small steps for `seconds`, noting when the wave left. */
  function run(h: HerzieModel, seconds: number) {
    let released = -1;
    for (let t = 0; t < seconds; t += 1 / 120) {
      h.update(1 / 120, 0);
      if (h.released) released = t;
    }
    return released;
  }
  const forward = (h: HerzieModel) =>
    new THREE.Vector3(Math.sin(h.heading), 0, Math.cos(h.heading));

  it("lets the wave go once, at the release, and finishes", () => {
    const h = new HerzieModel(LOOK);
    h.cast();
    expect(h.casting).toBe(true);
    const at = run(h, CAST_SECONDS + 0.1);
    expect(at).toBeGreaterThan(CAST_RELEASE_SECONDS - 0.02);
    expect(at).toBeLessThan(CAST_RELEASE_SECONDS + 0.02);
    expect(h.casting).toBe(false);
  });

  it("holds still on a blow that lands, then finishes that much later", () => {
    const h = new HerzieModel(LOOK);
    h.cast(0, { style: "strike" });
    // Up to the blow…
    const at = run(h, CAST_RELEASE_SECONDS + 0.01);
    expect(at).toBeGreaterThan(0);
    h.hitstop();
    expect(h.stopped).toBe(true);
    // …held there through the stop…
    const phase = h.castPhase;
    run(h, HITSTOP_SECONDS - 0.02);
    expect(h.castPhase).toBe(phase);
    // …then on, finishing late by the stop.
    run(h, CAST_SECONDS - CAST_RELEASE_SECONDS - 0.01);
    expect(h.casting).toBe(true);
    run(h, HITSTOP_SECONDS + 0.02);
    expect(h.casting).toBe(false);
  });

  for (const stage of [1, 2, 3]) {
    it(`thrusts a hand out in front at stage ${stage}`, () => {
      const h = new HerzieModel({ ...LOOK, stage });
      h.heading = 1.1;
      h.update(0, 0);
      const middle = new THREE.Vector3(0, h.height / 2, 0);
      h.cast();
      run(h, CAST_RELEASE_SECONDS + 0.01);
      const hand = h.handWorldPosition(new THREE.Vector3());
      const ahead = hand.clone().sub(middle).dot(forward(h));
      // Out in front of its middle, at about its own height.
      expect(ahead).toBeGreaterThan(0.3);
      expect(hand.y).toBeGreaterThan(0);
      expect(hand.y).toBeLessThan(h.height);
    });
  }

  it("aims the hand up when the cast is aimed up", () => {
    const level = new HerzieModel(LOOK);
    const up = new HerzieModel(LOOK);
    level.cast(0);
    up.cast(0.6);
    run(level, CAST_RELEASE_SECONDS + 0.01);
    run(up, CAST_RELEASE_SECONDS + 0.01);
    const v = new THREE.Vector3();
    expect(up.handWorldPosition(v).y).toBeGreaterThan(
      level.handWorldPosition(new THREE.Vector3()).y,
    );
  });

  it("is back as it was once the cast is over", () => {
    const a = new HerzieModel(LOOK);
    const b = new HerzieModel(LOOK);
    b.cast();
    run(a, CAST_SECONDS + 0.2);
    run(b, CAST_SECONDS + 0.2);
    expect(bounds(b).max.toArray()).toEqual(bounds(a).max.toArray());
    expect(bounds(b).min.toArray()).toEqual(bounds(a).min.toArray());
  });
});

describe("a spirit dancing", () => {
  const WITH_SPIRIT = {
    seed: "model-test",
    stage: 3,
    equipped: { spirit: "spirit-orb" },
  };
  /** How high the spirit flies over its herzie's feet (world units). */
  const spiritHeight = (h: HerzieModel) => {
    h.root.updateMatrixWorld(true);
    // The follower: the root's first child, added before the herzie's own.
    return h.root.children[0].getWorldPosition(new THREE.Vector3()).y;
  };

  for (const [where, options] of [
    ["in the Town", {}],
    ["on its own stage", { anchorScenery: 0 }],
  ] as const) {
    it(`surges up now and then, and settles when the music stops (${where})`, () => {
      const h = new HerzieModel(WITH_SPIRIT, options);
      const measure = () => {
        if (!("anchorScenery" in options)) return spiritHeight(h);
        // Anchored: the spirit's own parts move. Its highest part.
        let top = Number.NEGATIVE_INFINITY;
        h.root.updateMatrixWorld(true);
        const { model, meshes } = h as unknown as {
          model: { spheres: { part: string }[] };
          meshes: THREE.Mesh[];
        };
        model.spheres.forEach((s, k) => {
          if (s.part === "spirit")
            top = Math.max(
              top,
              meshes[k].getWorldPosition(new THREE.Vector3()).y,
            );
        });
        return top;
      };
      h.update(1 / 60, 0);
      const rest = measure();
      h.dancing = true;
      let most = rest;
      for (let i = 0; i < 6 * 60; i++) {
        h.update(1 / 60, 0);
        most = Math.max(most, measure());
      }
      // Well above the dance's own gentle bob.
      expect(most - rest).toBeGreaterThan(0.12 * MODEL_SCALE * 1.5);
      h.dancing = false;
      for (let i = 0; i < 4 * 60; i++) h.update(1 / 60, 0);
      // Its surge let go (it idles about on its own, after).
      const { surge } = h as unknown as { surge: { y: number; pulse: null } };
      expect(surge.pulse).toBeNull();
      expect(Math.abs(surge.y)).toBeLessThan(1e-3);
    });
  }
});

describe("drawing class gear", () => {
  const BARD = {
    seed: "model-test",
    stage: 3,
    equipped: { main_hand: "lute" },
  };
  const step = (h: HerzieModel, seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / 120) h.update(1 / 120, 0);
  };

  it("draws it as soon as it aims, quickly", () => {
    const h = new HerzieModel(BARD);
    h.update(0, 0);
    expect(h.drawn).toBe(0);
    h.armed = true;
    step(h, DRAW_SECONDS + 1 / 60);
    expect(h.drawn).toBe(1);
  });

  it("turns back the way it came when aiming stops mid-draw", () => {
    const h = new HerzieModel(BARD);
    h.armed = true;
    step(h, DRAW_SECONDS / 2);
    const half = h.drawn;
    h.armed = false;
    // Holds it a moment (aiming again inside that keeps it in hand)…
    step(h, SHEATHE_DELAY - 0.02);
    expect(h.drawn).toBeCloseTo(half, 5);
    // …then eases it back, never past where it was.
    step(h, 0.05);
    expect(h.drawn).toBeLessThan(half);
    step(h, SHEATHE_SECONDS);
    expect(h.drawn).toBe(0);
  });

  it("has it in hand by the time a cast's wave leaves, aiming or not", () => {
    const h = new HerzieModel(BARD);
    h.update(0, 0);
    h.cast();
    let released = false;
    for (let t = 0; t < CAST_SECONDS && !released; t += 1 / 120) {
      h.update(1 / 120, 0);
      released = h.released;
    }
    expect(released).toBe(true);
    expect(h.drawn).toBeCloseTo(1, 5);
    expect(CAST_RELEASE_SECONDS).toBeLessThan(DRAW_SECONDS);
  });

  it("keeps it inside its bounds all the way through the draw", () => {
    for (const equipped of [
      { main_hand: "lute" },
      { main_hand: "worn-stick", off_hand: "old-cymbal" },
      { main_hand: "compact-discs" },
    ]) {
      const h = new HerzieModel({ seed: "model-test", stage: 3, equipped });
      h.armed = true;
      for (let t = 0; t < DRAW_SECONDS + 0.05; t += 1 / 120) {
        h.update(1 / 120, 0);
        h.root.updateMatrixWorld(true);
        h.root.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          o.geometry.computeBoundingSphere();
          const part = o.geometry.boundingSphere
            ?.clone()
            .applyMatrix4(o.matrixWorld);
          if (!part) return;
          expect(
            h.bounds.center.distanceTo(part.center) + part.radius,
          ).toBeLessThanOrEqual(h.bounds.radius);
        });
      }
    }
  });

  it("starts with it drawn when built armed", () => {
    const h = new HerzieModel(BARD, { armed: true });
    expect(h.drawn).toBe(1);
    expect(h.armed).toBe(true);
  });

  it("puts it away again after a cast it wasn't aiming for", () => {
    const h = new HerzieModel(BARD);
    h.cast();
    step(h, CAST_SECONDS + SHEATHE_DELAY + SHEATHE_SECONDS + 0.05);
    expect(h.drawn).toBe(0);
  });
});

describe("discs on threads", () => {
  const SLINGER = {
    seed: "model-test",
    stage: 3,
    equipped: { main_hand: "compact-discs" },
  };
  /** Each disc's middle, in the world. */
  const discs = (h: HerzieModel) => {
    const inner = h as unknown as {
      meshes: THREE.Mesh[];
      model: { spheres: Sphere[] };
    };
    h.root.updateMatrixWorld(true);
    return ["held-l", "held-r"].map((part) => {
      const i = inner.model.spheres.findIndex((s) => s.part === part);
      return inner.meshes[i].getWorldPosition(new THREE.Vector3());
    });
  };
  const frames = (h: HerzieModel, seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds; t += 1 / 120) {
      each?.();
      h.update(1 / 120, 0);
    }
  };

  it("trails behind as it turns", () => {
    const h = new HerzieModel(SLINGER);
    h.threadConfig = { ...DEFAULT_THREAD_CONFIG, response: 1 };
    frames(h, 0.2);
    frames(h, 0.3, () => {
      h.heading += 5 / 120;
    });
    const [, lower] = discs(h);
    // Angle about its vertical (forward is (sin, cos)): behind it is
    // heading + π; the disc is short of that, back the way it came from.
    const at = Math.atan2(lower.x, lower.z);
    let lag = at - (h.heading + Math.PI);
    lag -= Math.round(lag / (Math.PI * 2)) * Math.PI * 2;
    expect(lag).toBeLessThan(-0.001);
  });

  it("trails out behind as it walks", () => {
    const h = new HerzieModel(SLINGER);
    // A stiff breeze: a walk's default one barely lifts them off the back.
    h.threadConfig = { ...DEFAULT_THREAD_CONFIG, drag: 6, response: 1 };
    frames(h, 0.2);
    const behind = () => {
      const [, lower] = discs(h);
      // Behind its feet: against forward, (sin, cos) of the heading.
      return (
        -(lower.x - h.root.position.x) * Math.sin(h.heading) -
        (lower.z - h.root.position.z) * Math.cos(h.heading)
      );
    };
    const resting = behind();
    frames(h, 1, () => {
      h.root.position.z += 4.5 / 120;
    });
    expect(behind()).toBeGreaterThan(resting + 0.005);
  });

  it("is taken from mid-swing without a jump", () => {
    const h = new HerzieModel(SLINGER);
    frames(h, 0.2);
    frames(h, 0.3, () => {
      h.heading += 6 / 120;
    });
    h.armed = true;
    let prev = discs(h);
    const steps: number[][] = [[], []];
    frames(h, DRAW_SECONDS + 0.1, () => {
      const now = discs(h);
      now.forEach((p, i) => {
        steps[i].push(p.distanceTo(prev[i]));
      });
      prev = now;
    });
    for (const run of steps) {
      run.forEach((step, k) => {
        const near = Math.max(run[k - 1] ?? 0, run[k + 1] ?? 0);
        expect(step).toBeLessThan(near * 3 + 0.02);
      });
    }
  });

  it("swings inside its bounds", () => {
    const h = new HerzieModel(SLINGER);
    frames(h, 1.5, () => {
      h.heading += 10 / 120;
      h.root.position.x += 6 / 120;
      h.root.updateMatrixWorld(true);
      const center = h.bounds.center.clone().add(h.root.position);
      h.root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.computeBoundingSphere();
        const part = o.geometry.boundingSphere
          ?.clone()
          .applyMatrix4(o.matrixWorld);
        if (!part) return;
        expect(
          center.distanceTo(part.center) + part.radius,
        ).toBeLessThanOrEqual(h.bounds.radius);
      });
    });
  });
});
