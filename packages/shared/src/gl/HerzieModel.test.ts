import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  buildCreatureModel,
  castHand,
  SLAM,
  type Sphere,
  slamBody,
} from "../creature-renderer.js";
import { SKILL_DEFS } from "../skills.js";
import { DEFAULT_THREAD_CONFIG } from "../thread-physics.js";
import { WALK_SPEED } from "./animation.js";
import {
  CAST_RELEASE_SECONDS,
  CAST_SECONDS,
  DRAW_SECONDS,
  HerzieModel,
  HITSTOP_SECONDS,
  JUMP_AIR_SECONDS,
  JUMP_HEIGHT,
  MODEL_SCALE,
  SHEATHE_DELAY,
  SHEATHE_SECONDS,
  SLAM_RELEASE_SECONDS,
  SLAM_SECONDS,
  waveHop,
} from "./HerzieModel.js";
import { SHOE_UPPER } from "./props.js";

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

  it("has its cat hop up on the boombox at Home, whichever way it faces", () => {
    // As the Town's Home sets it up: the boombox in the corner of Home's
    // frame, fading in once there; the herzie standing still.
    type Cat = {
      state: { perched: boolean; position: THREE.Vector3; heading: number };
    };
    for (const heading of [0, 0.6, -0.6, 2, Math.PI]) {
      const h = new HerzieModel(
        {
          seed: "heybob",
          stage: 3,
          equipped: { ground_left: "boombox", spirit: "sleptwell" },
        },
        { anchorGround: true, layoutCols: 126, layoutRows: 40 },
      );
      h.heading = heading;
      const { cat } = h as unknown as { cat: Cat };
      let up = -1;
      for (let f = 0; f < 60 * 10; f++) {
        const t = f / 60;
        h.setAccessories(Math.min(1, Math.max(0, t - 1)));
        h.setAccessoryHeading(heading);
        h.update(1 / 60, 0);
        if (cat.state.perched && up < 0) up = t;
      }
      expect(cat.state.perched).toBe(true);
      expect(up).toBeLessThan(6);
      // On it: over the boombox's middle.
      const box = h.accessoryWorldBox(new THREE.Box3()) as THREE.Box3;
      const mid = box.getCenter(new THREE.Vector3());
      expect(
        Math.hypot(cat.state.position.x - mid.x, cat.state.position.z - mid.z),
      ).toBeLessThan(0.2);
      // Facing the camera, as the herzie does at Home.
      expect(Math.cos(cat.state.heading - heading)).toBeGreaterThan(0.95);
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

describe("HerzieModel jump", () => {
  const step = (h: HerzieModel, seconds: number, speed = 0) => {
    for (let t = 0; t < seconds; t += 1 / 60) h.update(1 / 60, speed);
  };

  it("hops up to its height and lands within its air time", () => {
    const h = new HerzieModel(LOOK);
    h.update(1 / 60, 0);
    const ground = bounds(h).min.y;
    expect(h.jump()).toBe(true);
    let peak = 0;
    for (let t = 0; t < JUMP_AIR_SECONDS - 1 / 60; t += 1 / 60) {
      h.update(1 / 60, WALK_SPEED);
      peak = Math.max(peak, h.jumpHeight);
      expect(h.airborne).toBe(true);
    }
    expect(peak).toBeGreaterThan(JUMP_HEIGHT * 0.95);
    expect(peak).toBeLessThanOrEqual(JUMP_HEIGHT + 1e-6);
    step(h, 2 / 60);
    expect(h.airborne).toBe(false);
    step(h, 0.5);
    expect(bounds(h).min.y).toBeCloseTo(ground, 2);
  });

  it("lifts the body off the ground mid-air", () => {
    const h = new HerzieModel(LOOK);
    h.update(1 / 60, 0);
    const ground = bounds(h).min.y;
    h.jump();
    step(h, JUMP_AIR_SECONDS / 2);
    expect(bounds(h).min.y).toBeGreaterThan(ground + JUMP_HEIGHT * 0.8);
  });

  it("jumps again on landing when pressed just before", () => {
    const h = new HerzieModel(LOOK);
    h.jump();
    step(h, JUMP_AIR_SECONDS - 0.06);
    expect(h.jump()).toBe(false);
    expect(h.jumps).toBe(1);
    step(h, 0.1);
    expect(h.jumps).toBe(2);
    expect(h.airborne).toBe(true);
  });

  it("forgets a press made long before landing", () => {
    const h = new HerzieModel(LOOK);
    h.jump();
    step(h, 0.05);
    h.jump();
    step(h, JUMP_AIR_SECONDS);
    expect(h.jumps).toBe(1);
  });

  it("doesn't jump seated", () => {
    const h = new HerzieModel(LOOK);
    h.sitting = true;
    step(h, 0.5);
    expect(h.jump()).toBe(false);
    expect(h.airborne).toBe(false);
  });
});

describe("cloaks", () => {
  const CLOAKED = {
    seed: "model-test",
    stage: 3,
    equipped: { back: "troubadour-mantle" },
  };
  /** The cloak's mesh (the one drawn both sides). */
  const cloakMesh = (h: HerzieModel) => {
    let found: THREE.Mesh | null = null;
    h.root.traverse((o) => {
      if (
        o instanceof THREE.Mesh &&
        o.material instanceof THREE.ShaderMaterial &&
        o.material.side === THREE.DoubleSide
      )
        found = o;
    });
    return found as THREE.Mesh | null;
  };
  /** The middle of its hem, in the world. */
  const hem = (h: HerzieModel) => {
    const mesh = cloakMesh(h);
    if (!mesh) throw new Error("no cloak");
    const pos = mesh.geometry.attributes.position;
    const uv = mesh.geometry.attributes.uv;
    let at = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < uv.count; i++) {
      const d = Math.abs(uv.getX(i) - 0.5) + Math.abs(uv.getY(i) - 1);
      if (d < best) {
        best = d;
        at = i;
      }
    }
    h.root.updateMatrixWorld(true);
    return mesh.localToWorld(
      new THREE.Vector3(pos.getX(at), pos.getY(at), pos.getZ(at)),
    );
  };

  it("is worn only at stage 3, with a cloak on its back", () => {
    expect(cloakMesh(new HerzieModel(CLOAKED))).not.toBeNull();
    expect(new HerzieModel(CLOAKED).hasCloak).toBe(true);
    expect(new HerzieModel({ ...CLOAKED, stage: 2 }).hasCloak).toBe(false);
    expect(new HerzieModel(LOOK).hasCloak).toBe(false);
  });

  it("hangs down its back, and trails behind as it walks", () => {
    const h = new HerzieModel(CLOAKED);
    const still = hem(h);
    // Behind it (heading 0 faces +z), below the head.
    expect(still.z).toBeLessThan(0);
    expect(still.y).toBeLessThan(h.height * 0.6);
    for (let t = 0; t < 1.5; t += 1 / 60) {
      h.root.position.z += WALK_SPEED / 60;
      h.update(1 / 60, WALK_SPEED);
    }
    expect(hem(h).z - h.root.position.z).toBeLessThan(still.z - 0.1);
  });

  it("floats up through a hop and flops back down on landing", () => {
    const h = new HerzieModel(CLOAKED);
    for (let t = 0; t < 1; t += 1 / 60) h.update(1 / 60, 0);
    // Its hem's height in the body's own frame (creature space: y down),
    // which hops and stretches with it.
    const lift = () => {
      const mesh = cloakMesh(h) as THREE.Mesh;
      return -(mesh.parent as THREE.Object3D).worldToLocal(hem(h)).y;
    };
    const rest = lift();
    h.jump();
    // Already floating by the top of the hop, not only once it's landed.
    for (let t = 0; t < JUMP_AIR_SECONDS * 0.6; t += 1 / 60)
      h.update(1 / 60, 0);
    expect(lift() - rest).toBeGreaterThan(0.025);
    let peak = 0;
    while (h.airborne) {
      h.update(1 / 60, 0);
      peak = Math.max(peak, lift() - rest);
    }
    for (let t = 0; t < 1.5; t += 1 / 60) h.update(1 / 60, 0);
    expect(Math.abs(lift() - rest)).toBeLessThan(peak * 0.4);
  });

  it("isn't flung up by its own attacks", () => {
    for (const style of ["cast", "bump"] as const) {
      const h = new HerzieModel({
        ...CLOAKED,
        equipped: { ...CLOAKED.equipped, main_hand: "lute" },
      });
      for (let t = 0; t < 1; t += 1 / 60) h.update(1 / 60, 0);
      // Its hem, in the body's own frame (y down).
      const lift = () => {
        const mesh = cloakMesh(h) as THREE.Mesh;
        return -(mesh.parent as THREE.Object3D).worldToLocal(hem(h)).y;
      };
      const rest = lift();
      h.cast(0, { style });
      let most = 0;
      for (let t = 0; t < 1.5; t += 1 / 60) {
        h.update(1 / 60, 0);
        most = Math.max(most, lift() - rest);
      }
      // A bump once threw it up over its shoulders (1.9).
      expect(most, style).toBeLessThan(0.3);
    }
  });

  it("isn't lifted at its sides by the hand reaching over for its gear", () => {
    const h = new HerzieModel({
      ...CLOAKED,
      equipped: { ...CLOAKED.equipped, main_hand: "worn-stick" },
    });
    for (let t = 0; t < 1; t += 1 / 60) h.update(1 / 60, 0);
    // How high its side edges' lower halves are, highest, in the body's
    // own frame (y down).
    const sides = () => {
      const mesh = cloakMesh(h) as THREE.Mesh;
      const pos = mesh.geometry.attributes.position;
      const uv = mesh.geometry.attributes.uv;
      let top = Number.POSITIVE_INFINITY;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i);
        if (uv.getY(i) > 0.5 && (u < 0.02 || u > 0.98))
          top = Math.min(top, pos.getY(i));
      }
      return -top;
    };
    const rest = sides();
    // Drawn for a cast, and put away again after.
    h.cast(0);
    let most = 0;
    for (let t = 0; t < 2; t += 1 / 60) {
      h.update(1 / 60, 0);
      most = Math.max(most, sides() - rest);
    }
    expect(most).toBeLessThan(0.15);
  });

  it("settles, so a still view can stop drawing", () => {
    const h = new HerzieModel(CLOAKED);
    // As a paused view steps it: the rest held still, the swing let run.
    const paused = () => {
      h.swing(1 / 60);
      h.update(0, 0);
    };
    for (let t = 0; t < 2; t += 1 / 60) paused();
    expect(h.dangleSettled).toBe(true);
    h.heading += 1;
    h.swing(1 / 60);
    expect(h.dangleSettled).toBe(false);
  });

  it("slings class gear on top of it", () => {
    const gear = { main_hand: "lute" };
    const lute = (equipped: Record<string, string>) => {
      const { spheres } = buildCreatureModel("model-test", 3, equipped);
      const body = spheres.find((s) => s.part === "body") as Sphere;
      const held = spheres.filter((s) => s.held);
      return Math.max(
        ...held.map((s) =>
          Math.hypot(...s.center.map((v, k) => v - body.center[k])),
        ),
      );
    };
    expect(lute({ ...gear, back: "groove-cape" })).toBeGreaterThan(
      lute(gear) + 0.05,
    );
  });

  it("keeps its cloth under the gear slung over it", () => {
    // How far a point is inside a held solid (positive: inside).
    const inside = (p: THREE.Vector3, s: Sphere, mesh: THREE.Object3D) => {
      const d = p.clone().sub(mesh.position);
      if (!s.shape) return s.radius - d.length();
      const half = Math.hypot(...s.shape.axis);
      const u = new THREE.Vector3(0, 1, 0).applyQuaternion(mesh.quaternion);
      const t = d.dot(u);
      if (s.shape.kind === "capsule") {
        const tt = Math.max(-half, Math.min(half, t));
        return s.radius - d.sub(u.multiplyScalar(tt)).length();
      }
      const radial = d.clone().sub(u.clone().multiplyScalar(t)).length();
      const dome =
        (s.shape.dome ?? 0) * Math.max(0, 1 - (radial / s.radius) ** 2);
      return Math.min(s.radius - radial, half + dome - Math.abs(t));
    };
    for (const back of ["groove-cape", "troubadour-mantle"]) {
      const h = new HerzieModel({
        seed: "model-test",
        stage: 3,
        equipped: { back, main_hand: "lute" },
      });
      for (let t = 0; t < 2; t += 1 / 60) h.update(1 / 60, 0);
      // biome-ignore lint/suspicious/noExplicitAny: reading the drawn cloth
      const m = h as any;
      const surface: Float32Array = m.cloak.surface;
      const spheres: Sphere[] = m.model.spheres;
      let worst = 0;
      spheres.forEach((s, i) => {
        if (!s.held) return;
        for (let p = 0; p < surface.length; p += 3) {
          const at = new THREE.Vector3(
            surface[p],
            surface[p + 1],
            surface[p + 2],
          );
          worst = Math.max(worst, inside(at, s, m.meshes[i]));
        }
      });
      expect(worst).toBe(0);
    }
  });

  it("is bounded where it can swing, and freed with the model", () => {
    const h = new HerzieModel(CLOAKED);
    const plain = new HerzieModel(LOOK);
    expect(h.bounds.radius).toBeGreaterThan(plain.bounds.radius);
    const mesh = cloakMesh(h);
    let disposed = false;
    mesh?.geometry.addEventListener("dispose", () => {
      disposed = true;
    });
    h.dispose();
    expect(disposed).toBe(true);
  });

  it("is greyed and petrified with the rest of it", () => {
    const h = new HerzieModel(CLOAKED);
    const material = cloakMesh(h)?.material as THREE.ShaderMaterial;
    const before = (
      material.uniforms.uLining.value as THREE.Color[]
    )[1].clone();
    h.petrify();
    const after = (material.uniforms.uLining.value as THREE.Color[])[1];
    expect(after.equals(before)).toBe(false);
  });
});

describe("the stage 2 wave hop", () => {
  it("leaves and lands on the ground, with no jumps in height or shape", () => {
    expect(waveHop(0)).toEqual({ lift: 0, squash: 0 });
    expect(waveHop(2)).toEqual({ lift: 0, squash: 0 });
    let prev = waveHop(0);
    let top = 0;
    for (let t = 0.001; t < 1; t += 0.001) {
      const h = waveHop(t);
      expect(Math.abs(h.lift - prev.lift)).toBeLessThan(0.01);
      expect(Math.abs(h.squash - prev.squash)).toBeLessThan(0.01);
      top = Math.max(top, h.lift);
      prev = h;
    }
    expect(top).toBeGreaterThan(0.3);
    expect(top).toBeLessThan(JUMP_HEIGHT);
  });
});

describe("waving again mid-wave", () => {
  const run = (m: HerzieModel, seconds: number) => {
    const step = 1 / 120;
    for (let t = 0; t < seconds; t += step) m.update(step, 0);
  };

  it("carries the wave on past where one would end", () => {
    const m = new HerzieModel(LOOK);
    expect(m.emote("wave")).toBe(true);
    run(m, 0.5);
    expect(m.emote("wave")).toBe(true);
    run(m, 1.3); // 1.8s in: one wave alone would be over
    expect(m.emoting).toBe(true);
    run(m, 2);
    expect(m.emoting).toBe(false);
  });

  it("waved again as the arm comes down, plays another after", () => {
    const m = new HerzieModel(LOOK);
    m.emote("wave");
    run(m, 1.45);
    m.emote("wave");
    run(m, 0.3); // 1.75s in
    expect(m.emoting).toBe(true);
    run(m, 1.7);
    expect(m.emoting).toBe(false);
  });
});

describe("HerzieModel with Sleptwell, the cat", () => {
  const CAT = { seed: "cat-test", stage: 3, equipped: { spirit: "sleptwell" } };

  it("walks a cat after it, not a floating spirit", () => {
    const h = new HerzieModel(CAT);
    expect(h.hasCompanion).toBe(true);
    expect(h.companionKind).toBe("walker");
    let skinned = 0;
    h.root.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) skinned++;
    });
    expect(skinned).toBe(1);
  });

  it("keeps up with it, on the ground", () => {
    const h = new HerzieModel(CAT);
    for (let i = 0; i < 300; i++) {
      h.root.position.z += WALK_SPEED / 60;
      h.update(1 / 60, WALK_SPEED);
    }
    const at = h.companionPosition(new THREE.Vector3());
    expect(at).not.toBeNull();
    const m = at as THREE.Vector3;
    expect(Math.hypot(m.x, m.z - h.root.position.z)).toBeLessThan(4);
    // It's at a cat's height, not up in the air.
    expect(m.y).toBeGreaterThan(0.2);
    expect(m.y).toBeLessThan(1.2);
  });

  it("stays where it was when other gear goes on (rebuilt, carried over)", () => {
    const h = new HerzieModel(CAT);
    for (let i = 0; i < 200; i++) {
      h.root.position.z += WALK_SPEED / 60;
      h.heading = 0.4;
      h.update(1 / 60, WALK_SPEED);
    }
    const cat = h.companionPosition(new THREE.Vector3()) as THREE.Vector3;
    const hatted = new HerzieModel({
      ...CAT,
      equipped: { ...CAT.equipped, head: "headphones" },
    });
    hatted.carryOver(h);
    h.dispose();
    hatted.update(1 / 60, WALK_SPEED);
    const after = hatted.companionPosition(
      new THREE.Vector3(),
    ) as THREE.Vector3;
    expect(after.distanceTo(cat)).toBeLessThan(0.2);
    expect(hatted.root.position.z).toBeCloseTo(h.root.position.z);
    expect(hatted.heading).toBe(0.4);
    expect(hatted.anim.walkWeight).toBeGreaterThan(0.9);
  });

  it("sits beside a herzie on its own stage, and isn't sent fetching", () => {
    const h = new HerzieModel(CAT, { anchorScenery: 0 });
    expect(h.hasCompanion).toBe(false);
    for (let i = 0; i < 120; i++) h.update(1 / 60, 0);
    expect(h.companionPosition(new THREE.Vector3())).toBeNull();
  });
});

describe("a slam (Rimshot)", () => {
  const DRUMMER = {
    seed: "model-test",
    stage: 3,
    equipped: { main_hand: "worn-stick", off_hand: "old-cymbal" },
  };

  it("lands once, at the end of Rimshot's wind-up, and takes its own time", () => {
    const h = new HerzieModel(DRUMMER);
    h.cast(0, { style: "slam" });
    let landed = 0;
    let at = -1;
    let t = 0;
    for (; t < SLAM_SECONDS + 0.2; t += 1 / 120) {
      h.update(1 / 120, 0);
      if (h.released) {
        landed++;
        at = t;
      }
      if (!h.casting) break;
    }
    expect(landed).toBe(1);
    expect(at).toBeCloseTo(SLAM_RELEASE_SECONDS, 1);
    expect(SLAM_RELEASE_SECONDS * 1000).toBeCloseTo(
      SKILL_DEFS.rimshot.castMs ?? 0,
    );
    expect(t).toBeGreaterThan(SLAM_SECONDS - 0.02);
  });

  it("leaves the other moves' timing alone", () => {
    const h = new HerzieModel(DRUMMER);
    h.cast(0, { style: "slam" });
    h.update(0.1, 0);
    h.cast(0, { style: "strike" });
    let released = -1;
    for (let t = 0; t < CAST_SECONDS + 0.1; t += 1 / 120) {
      h.update(1 / 120, 0);
      if (h.released) released = t;
    }
    expect(released).toBeCloseTo(CAST_RELEASE_SECONDS, 1);
    expect(h.casting).toBe(false);
  });

  it("raises the stick overhead, then drives it down in front", () => {
    // Creature space: y down, front −z.
    const up = castHand(SLAM.hold - 0.01, 0, "arm-l", "slam").dir;
    expect(up[1]).toBeLessThan(-0.6);
    const down = castHand(SLAM.release + 0.01, 0, "arm-l", "slam").dir;
    expect(down[1]).toBeGreaterThan(0.5);
    expect(down[2]).toBeLessThan(-0.4);
  });

  it("crouches, rises on its toes, and lands the blow with a squash", () => {
    expect(slamBody(SLAM.raised).squash).toBeGreaterThan(0.05);
    expect(slamBody((SLAM.hold + SLAM.hop) / 2).lift).toBeGreaterThan(0.1);
    expect(slamBody(SLAM.release + 0.005).squash).toBeGreaterThan(0.15);
    expect(Math.abs(slamBody(0.999).squash)).toBeLessThan(0.03);
  });

  it("can be cut short", () => {
    const h = new HerzieModel(DRUMMER);
    h.cast(0, { style: "slam" });
    h.update(0.3, 0);
    h.cancelCast();
    expect(h.casting).toBe(false);
    h.update(0.6, 0);
    expect(h.released).toBe(false);
  });
});

describe("FF Pink (a see-through skin)", () => {
  /** Its body's materials: the ones drawn blended over a depth prepass. */
  const glassOf = (h: HerzieModel) => {
    const found = new Set<THREE.ShaderMaterial>();
    h.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (m?.defines && "GLASS" in m.defines) found.add(m);
    });
    return [...found];
  };
  const prepasses = (h: HerzieModel) => {
    let n = 0;
    h.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && !m.colorWrite) n++;
    });
    return n;
  };
  const pink = { seed: "glass-test", stage: 3, equipped: { color: "ff-pink" } };

  it("draws the body as glass, each part over a depth prepass", () => {
    const h = new HerzieModel(pink);
    const glass = glassOf(h);
    expect(glass.length).toBeGreaterThan(0);
    for (const m of glass) {
      expect(m.transparent).toBe(true);
      expect(m.depthWrite).toBe(false);
    }
    expect(prepasses(h)).toBeGreaterThan(0);
    // The eyes stay solid.
    h.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (m?.uniforms?.uScheme?.value === false && m.defines)
        expect("GLASS" in m.defines).toBe(false);
    });
  });

  it("draws its solid parts over the glass's depth, so their insides hide", () => {
    const h = new HerzieModel({
      ...pink,
      equipped: { color: "ff-pink", head: "fabulous-fabian" },
    });
    const orders = new Set<number>();
    h.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const m = mesh.material as THREE.ShaderMaterial | undefined;
      if (!mesh.isMesh || !m?.uniforms?.uShades || "GLASS" in (m.defines ?? {}))
        return;
      if (!m.visible) return;
      orders.add(mesh.renderOrder);
      expect(m.transparent).toBe(true);
    });
    // Glass prepass 10, solids 11, glass 12.
    expect([...orders]).toEqual([11]);
    // Back to normal as stone.
    h.petrify();
    h.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh)
        expect((o as THREE.Mesh).renderOrder).toBe(0);
    });
  });

  it("stays see-through when tinted fully opaque", () => {
    const h = new HerzieModel(pink);
    h.setTint(0, 0.5);
    h.setTint(0, 1);
    for (const m of glassOf(h)) expect(m.transparent).toBe(true);
  });

  it("goes solid when turned to stone", () => {
    const h = new HerzieModel(pink);
    h.petrify();
    expect(glassOf(h)).toHaveLength(0);
    expect(prepasses(h)).toBe(0);
  });

  it("is plain without it", () => {
    const h = new HerzieModel({ ...pink, equipped: { color: "prism" } });
    expect(glassOf(h)).toHaveLength(0);
    expect(prepasses(h)).toBe(0);
  });
});

describe("shoes", () => {
  /** Whether a point in a shoe's own frame (built at a leg radius of 1, y
   * down, toe −z) is inside it: its upper (SHOE_UPPER's ellipsoid, before
   * the toe slopes it) or its sole. A stride moves the foot a hair within
   * the shoe: within 3% of the leg's radius counts. */
  const insideShoe = (p: THREE.Vector3) => {
    const k = 0.03;
    if (p.y > 0.5 + k) return false;
    const u = SHOE_UPPER;
    const upper =
      (p.x / (u.rx + k)) ** 2 +
      ((p.y - u.y) / (u.ry + k)) ** 2 +
      ((p.z - u.z) / (u.rz + k)) ** 2;
    // The sole, across the foot's whole footprint.
    const sole = p.y > 0.26 && (p.x / 1.1) ** 2 + ((p.z - u.z) / 1.5) ** 2 < 1;
    return upper < 1 || sole;
  };

  it("keeps the feet inside the shoes all through a walk", () => {
    const h = new HerzieModel({
      seed: "shoe-walk",
      stage: 3,
      equipped: { feet: "ff-sneakers-black" },
    });
    const inner = h as unknown as {
      model: { spheres: Sphere[] };
      meshes: THREE.Mesh[];
      props: { group: THREE.Group; at: number }[];
    };
    const spheres = inner.model.spheres;
    const shoes = inner.props.filter(
      (p) => spheres[p.at].prop?.kind === "shoe",
    );
    expect(shoes).toHaveLength(2);
    h.update(0, 0);
    let worst = 0;
    for (let i = 0; i < 90; i++) {
      h.root.position.z += WALK_SPEED / 60;
      h.update(1 / 60, WALK_SPEED);
      h.root.updateMatrixWorld(true);
      for (const shoe of shoes) {
        const part = spheres[shoe.at].part;
        const legAt = spheres.findIndex(
          (sp) => sp.part === part && sp.zone !== "wearable",
        );
        const leg = inner.meshes[legAt];
        // Points all over the leg's sphere; those below the shoe's cuff
        // (y −0.45 in its frame, y down) must be inside the shoe.
        for (let a = 0; a < 16; a++) {
          for (let b = 1; b < 8; b++) {
            const t = (a / 16) * Math.PI * 2;
            const u = (b / 8) * Math.PI;
            const local = new THREE.Vector3(
              Math.sin(u) * Math.cos(t),
              Math.cos(u),
              Math.sin(u) * Math.sin(t),
            );
            const inShoe = shoe.group.worldToLocal(leg.localToWorld(local));
            if (inShoe.y > -0.45 && !insideShoe(inShoe)) worst++;
          }
        }
      }
    }
    expect(worst).toBe(0);
  });

  for (const feet of ["ff-sneakers-black", "eivinds-evasive-pair"]) {
    it(`draws ${feet} as a shoe model on each foot, no lower than the leg`, () => {
      const { spheres } = buildCreatureModel(
        "shoe-test",
        3,
        { feet },
        undefined,
        64,
        64,
      );
      const legs = spheres.filter(
        (s) =>
          (s.part === "leg-l" || s.part === "leg-r") && s.zone !== "wearable",
      );
      const shoes = spheres.filter((s) => s.prop?.kind === "shoe");
      expect(new Set(shoes.map((s) => s.prop)).size).toBe(2);
      const legBottom = Math.max(...legs.map((l) => l.center[1] + l.radius));
      for (const s of spheres.filter((s) => s.zone === "wearable"))
        expect(s.center[1] + s.radius).toBeLessThanOrEqual(legBottom + 1e-9);
      for (const s of shoes) {
        if (s.prop?.kind !== "shoe") continue;
        // The model's bottom (half the leg's radius below its middle) is
        // the leg's.
        expect(s.prop.center[1] + s.prop.r / 2).toBeCloseTo(legBottom, 6);
      }
    });
  }
});

describe("Fylling's Necktie", () => {
  const tied = {
    seed: "tie-test",
    stage: 3,
    equipped: { body: "fyllings-necktie" },
  };

  it("draws a smooth model, with a ribbon blade that sways", () => {
    const h = new HerzieModel(tied);
    let ribbon: THREE.Mesh | undefined;
    h.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && Array.isArray(m.material)) ribbon = m;
    });
    expect(ribbon).toBeDefined();
    const before = Array.from(
      (ribbon?.geometry.attributes.position.array as Float32Array) ?? [],
    );
    // Walk away and stop: the blade is flung about, then settles.
    for (let i = 0; i < 300; i++) h.update(1 / 60, 0);
    expect(h.dangleSettled).toBe(true);
    const after = Array.from(
      (ribbon?.geometry.attributes.position.array as Float32Array) ?? [],
    );
    expect(after.every(Number.isFinite)).toBe(true);
    expect(after.length).toBe(before.length);
  });
});

const spheresOf = (m: HerzieModel) =>
  (m as unknown as { model: { spheres: Sphere[] } }).model.spheres;

describe("the cheer, sit and mic drop emotes", () => {
  const run = (m: HerzieModel, seconds: number, speed = 0) => {
    const step = 1 / 120;
    for (let t = 0; t < seconds; t += step) m.update(step, speed);
  };

  it("cheers: arms thrown up, over by the end", () => {
    const m = new HerzieModel(LOOK);
    const arm = spheresOf(m).findIndex((s) => s.part === "arm-l");
    const meshes = (m as unknown as { meshes: THREE.Mesh[] }).meshes;
    run(m, 0.2);
    const rest = meshes[arm].position.y;
    expect(m.emote("cheer")).toBe(true);
    run(m, 0.5);
    expect(meshes[arm].position.y).toBeLessThan(rest - 0.2);
    run(m, 2);
    expect(m.emoting).toBe(false);
  });

  it("cheers with three hops, each above a normal jump's height", () => {
    const m = new HerzieModel(LOOK);
    const body = (m as unknown as { creature: THREE.Object3D }).creature;
    run(m, 0.3);
    const rest = body.position.y;
    m.emote("cheer");
    // Rises through half a jump's height: one per hop (the breathing and the
    // squash wobble a little too, well below it).
    const bar = JUMP_HEIGHT * 0.5;
    let up = false;
    let hops = 0;
    let top = 0;
    const step = 1 / 240;
    for (let t = 0; t < 1.6; t += step) {
      m.update(step, 0);
      const h = body.position.y - rest;
      top = Math.max(top, h);
      if (h > bar && !up) hops++;
      up = h > bar;
    }
    expect(hops).toBe(3);
    expect(top).toBeGreaterThan(JUMP_HEIGHT);
  });

  it("sits on the floor, and gets up when played again or walking off", () => {
    const m = new HerzieModel(LOOK);
    expect(m.emote("sit")).toBe(true);
    expect(m.floorSit).toBe(true);
    run(m, 1);
    expect(m.emote("sit")).toBe(true);
    expect(m.floorSit).toBe(false);
    m.emote("sit");
    run(m, 0.2, WALK_SPEED);
    expect(m.floorSit).toBe(false);
  });

  describe("rolling onto its back (no legs)", () => {
    const small = (stage: number) =>
      new HerzieModel({ seed: "model-test", stage, equipped: {} });
    const lay = (m: HerzieModel) =>
      (m as unknown as { layAngle: number }).layAngle;
    // The lowest point of the body parts, in creature space (y is down).
    const lowest = (m: HerzieModel) => {
      const inner = m as unknown as {
        meshes: THREE.Mesh[];
        model: { spheres: Sphere[] };
      };
      let low = Number.NEGATIVE_INFINITY;
      inner.model.spheres.forEach((sp, i) => {
        if (sp.part !== "body" && sp.part !== "head") return;
        low = Math.max(low, inner.meshes[i].position.y + sp.radius);
      });
      return low;
    };

    it.each([
      1, 2,
    ])("stage %i: rocks forward, rolls back, overshoots and settles", (stage) => {
      const m = small(stage);
      run(m, 0.3);
      m.emote("sit");
      let max = 0;
      let min = 0;
      const step = 1 / 120;
      for (let t = 0; t < 2.5; t += step) {
        m.update(step, 0);
        max = Math.max(max, lay(m));
        min = Math.min(min, lay(m));
      }
      // The wind-up forward, then past where it rests, then settled there.
      expect(max).toBeGreaterThan(0.05);
      expect(min).toBeLessThan(-1.55);
      expect(lay(m)).toBeGreaterThan(-1.56);
      expect(lay(m)).toBeLessThan(-1.44);
    });

    it("keeps resting on the ground all the way over", () => {
      const m = small(2);
      run(m, 0.3);
      const rest = lowest(m);
      m.emote("sit");
      const step = 1 / 120;
      for (let t = 0; t < 2; t += step) {
        m.update(step, 0);
        // Not sunk into the ground, nor floating off it.
        expect(Math.abs(lowest(m) - rest)).toBeLessThan(0.03);
      }
    });

    it("gets up again, rocking back first", () => {
      const m = small(1);
      m.emote("sit");
      run(m, 2.5);
      m.emote("sit");
      expect(m.floorSit).toBe(false);
      const first = lay(m);
      m.update(1 / 120, 0);
      // The first thing it does is rock further back.
      expect(lay(m)).toBeLessThan(first + 1e-9);
      run(m, 2.5);
      expect(Math.abs(lay(m))).toBeLessThan(0.01);
    });

    it("stands up when it walks off", () => {
      const m = small(1);
      m.emote("sit");
      run(m, 2);
      run(m, 2.5, WALK_SPEED);
      expect(Math.abs(lay(m))).toBeLessThan(0.01);
    });

    it("turns what it wears with it", () => {
      const m = new HerzieModel({
        seed: "model-test",
        stage: 1,
        equipped: { head: "headphones" },
      });
      const inner = m as unknown as {
        meshes: THREE.Mesh[];
        model: { spheres: Sphere[] };
      };
      const worn = inner.model.spheres
        .map((sp, i) => ({ sp, i }))
        .filter(({ sp }) => sp.shape && !sp.dangle);
      expect(worn.length).toBeGreaterThan(0);
      const facing = (i: number) =>
        new THREE.Vector3(0, 1, 0).applyQuaternion(inner.meshes[i].quaternion);
      const rested = worn.map(({ i }) => facing(i));
      m.emote("sit");
      run(m, 2.5);
      const pitch = lay(m);
      worn.forEach(({ sp, i }, k) => {
        const [ax, ay, az] = (sp.shape as { axis: [number, number, number] })
          .axis;
        const c = Math.cos(pitch);
        const s = Math.sin(pitch);
        const want = new THREE.Vector3(
          ax,
          ay * c - az * s,
          ay * s + az * c,
        ).normalize();
        expect(facing(i).distanceTo(want)).toBeLessThan(1e-3);
        // Not where it stood: an ear cup's face now points up, not out.
        if (Math.abs(ay) + Math.abs(az) > 1e-6)
          expect(facing(i).distanceTo(rested[k])).toBeGreaterThan(0.1);
      });
      // And back again once it's up.
      m.emote("sit");
      run(m, 2.5);
      worn.forEach(({ i }, k) => {
        expect(facing(i).distanceTo(rested[k])).toBeLessThan(1e-3);
      });
    });

    it("doesn't roll with legs: it sits", () => {
      const m = new HerzieModel(LOOK);
      m.emote("sit");
      run(m, 2);
      expect(lay(m)).toBe(0);
    });
  });

  it("won't sit on a seat that's already taken", () => {
    const m = new HerzieModel(LOOK);
    m.sitting = true;
    expect(m.emote("sit")).toBe(false);
    expect(m.emote("cheer")).toBe(false);
  });

  it("drops the mic: held up, then left where it lands", () => {
    const scene = new THREE.Scene();
    const m = new HerzieModel(LOOK);
    scene.add(m.root);
    expect(m.emote("micdrop")).toBe(true);
    const inner = (
      m as unknown as {
        mic: { group: THREE.Group; drop: { lying: boolean } | null };
      }
    ).mic;
    run(m, 1.2);
    // Held straight up in the hand, on the herzie.
    expect(inner.group.visible).toBe(true);
    expect(inner.drop).toBeNull();
    // Held level: its length (local y) lies flat in the world.
    inner.group.updateWorldMatrix(true, false);
    const along = new THREE.Vector3(0, 1, 0).transformDirection(
      inner.group.matrixWorld,
    );
    expect(Math.abs(along.y)).toBeLessThan(0.05);
    run(m, 1.0); // past the release
    expect(inner.drop).not.toBeNull();
    expect(inner.group.parent).toBe(scene);
    run(m, 1.0);
    expect(inner.drop?.lying).toBe(true);
    const at = inner.group.getWorldPosition(new THREE.Vector3());
    expect(at.y).toBeGreaterThanOrEqual(-1e-6);
    expect(at.y).toBeLessThan(0.4);
    // The herzie walks off: the mic stays.
    m.root.position.x = 6;
    run(m, 1);
    expect(m.emoting).toBe(false);
    expect(
      inner.group.getWorldPosition(new THREE.Vector3()).distanceTo(at),
    ).toBeLessThan(0.05);
    expect(inner.group.visible).toBe(true);
    // And fades after a while.
    run(m, 11);
    expect(inner.group.visible).toBe(false);
    expect(inner.drop).toBeNull();
  });

  it("can drop another mic about 2s after the last lands, replacing it", () => {
    const scene = new THREE.Scene();
    const m = new HerzieModel(LOOK);
    scene.add(m.root);
    expect(m.emote("micdrop")).toBe(true);
    run(m, 2.0); // let go at 1.8s: still falling or only just down
    expect(m.emote("micdrop")).toBe(false);
    run(m, 1.2); // down, but not 2s since
    expect(m.emote("micdrop")).toBe(false);
    run(m, 1.5); // 2s and more since it landed
    expect(m.emote("micdrop")).toBe(true);
    // The old mic is put away, the new one held.
    run(m, 0.5);
    const mic = (m as unknown as { mic: { drop: unknown } }).mic;
    expect(mic.drop).toBeNull();
  });

  it("lands the mic on the ground under it, hills and all", () => {
    const scene = new THREE.Scene();
    const m = new HerzieModel(LOOK);
    scene.add(m.root);
    // A slope: the floor rises with x, and the hand is out to one side.
    m.groundAt = (x) => 0.3 + x * 0.2;
    m.emote("micdrop");
    run(m, 4.5);
    const inner = m as unknown as {
      mic: { group: THREE.Group; drop: { lying: boolean; r: number } | null };
    };
    const g = inner.mic.group;
    expect(inner.mic.drop?.lying).toBe(true);
    // Nothing of it is below the floor there, and it touches it.
    const q = g.quaternion;
    const lowest = Math.min(
      new THREE.Vector3(0, 0.55, 0).applyQuaternion(q).y - 0.25,
      new THREE.Vector3(0, -1.35, 0).applyQuaternion(q).y - 0.56,
    );
    const r = inner.mic.drop?.r ?? 1;
    const floor = 0.3 + g.position.x * 0.2;
    expect(g.position.y + lowest * r).toBeGreaterThanOrEqual(floor - 1e-4);
    expect(g.position.y + lowest * r).toBeLessThan(floor + 1e-3);
  });

  it("rests on both the ball and the handle's end, not just the ball", () => {
    const scene = new THREE.Scene();
    const m = new HerzieModel(LOOK);
    scene.add(m.root);
    m.emote("micdrop");
    run(m, 4.5);
    const inner = m as unknown as {
      mic: { group: THREE.Group; drop: { r: number } | null };
    };
    const g = inner.mic.group;
    const r = inner.mic.drop?.r ?? 1;
    const bottom = (y: number, radius: number) =>
      g.position.y +
      new THREE.Vector3(0, y, 0).applyQuaternion(g.quaternion).y * r -
      radius * r;
    // The handle's end and the ball are both on the floor (y = 0).
    expect(Math.abs(bottom(0.55, 0.25))).toBeLessThan(0.01 * r + 1e-3);
    expect(Math.abs(bottom(-1.35, 0.56))).toBeLessThan(0.01 * r + 1e-3);
  });

  it("without arms the mic grows in the world beside it, then drops", () => {
    const scene = new THREE.Scene();
    const m = new HerzieModel({ seed: "model-test", stage: 1, equipped: {} });
    scene.add(m.root);
    m.emote("micdrop");
    const inner = m as unknown as {
      mic: { group: THREE.Group; drop: unknown };
    };
    // Never at full size on the first frame: it grows in from a point.
    m.update(1 / 60, 0);
    const first = inner.mic.group.scale.x;
    run(m, 0.05);
    const early = inner.mic.group.scale.x;
    expect(first).toBeLessThan(early);
    // In the world from the start, not on the herzie.
    expect(inner.mic.group.parent).toBe(scene);
    const spawned = inner.mic.group.getWorldPosition(new THREE.Vector3());
    // The herzie walks off while it grows: the mic stays where it appeared.
    m.root.position.x = 4;
    run(m, 0.4);
    const grown = inner.mic.group.scale.x;
    expect(first).toBeLessThan(grown * 0.1);
    expect(early).toBeLessThan(grown * 0.5);
    const hanging = inner.mic.group.getWorldPosition(new THREE.Vector3());
    expect(hanging.distanceTo(spawned)).toBeLessThan(1e-3);
    run(m, 2); // let go at 0.9s, down by now
    const y = inner.mic.group.getWorldPosition(new THREE.Vector3()).y;
    expect(y).toBeLessThan(0.3);
    expect(y).toBeLessThan(spawned.y);
  });

  it("plays on a herzie without arms or legs", () => {
    const m = new HerzieModel({ seed: "model-test", stage: 1, equipped: {} });
    for (const id of ["cheer", "micdrop"]) {
      expect(m.emote(id)).toBe(true);
      run(m, 3);
      expect(m.emoting).toBe(false);
    }
  });
});
