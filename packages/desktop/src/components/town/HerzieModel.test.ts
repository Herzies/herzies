import { buildCreatureModel } from "@herzies/shared";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { HerzieModel, MODEL_SCALE } from "./HerzieModel";

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
});
