import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildCreatureModel } from "../creature-renderer.js";
import { HerzieModel, MODEL_SCALE } from "./HerzieModel.js";

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
});
