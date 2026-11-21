import type * as THREE from "three";
import { describe, expect, it } from "vitest";
import { lanternMaterial } from "../Buildings";
import { lanternGlassGeometry } from "../Lamps";
import { mapById } from "../maps";
import { type Berth, berthOf, PIER_WIDTH } from "./berth";
import { DockModel, dockObstacles } from "./DockModel";

const berths = ["home", "wilds"].map((id) => berthOf(mapById(id)) as Berth);

/** How far (x, z) is from the pier's middle line, and how far along it
 * (0 its start, 1 its end). */
function offPier(b: Berth, x: number, z: number): { off: number; at: number } {
  const dx = b.pierEnd.x - b.pierStart.x;
  const dz = b.pierEnd.z - b.pierStart.z;
  const len2 = dx * dx + dz * dz;
  const at = ((x - b.pierStart.x) * dx + (z - b.pierStart.z) * dz) / len2;
  const t = Math.max(0, Math.min(1, at));
  return {
    off: Math.hypot(x - b.pierStart.x - t * dx, z - b.pierStart.z - t * dz),
    at,
  };
}

describe("the Sky Dock", () => {
  it("is on both islands", () => {
    for (const b of berths) expect(b).toBeTruthy();
  });

  it("keeps the pier clear: nothing solid on it", () => {
    for (const b of berths)
      for (const o of dockObstacles(b))
        expect(offPier(b, o.x, o.z).off - o.r).toBeGreaterThanOrEqual(
          PIER_WIDTH / 2,
        );
  });

  it("stands at the berth, in five draw calls, and disposes what it made", () => {
    for (const b of berths) {
      const dock = new DockModel(b);
      dock.update(1 / 60, 100, { bell: 0.3, strikes: 2 });
      expect(dock.root.position.x).toBeCloseTo(b.pierEnd.x);
      expect(dock.root.position.z).toBeCloseTo(b.pierEnd.z);
      const made = new Set<THREE.BufferGeometry | THREE.Material>();
      let calls = 0;
      dock.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        calls++;
        made.add(mesh.geometry);
        for (const m of [mesh.material].flat()) made.add(m);
      });
      expect(calls).toBe(5);
      const gone = new Set<unknown>();
      for (const x of made)
        x.addEventListener("dispose", () => {
          gone.add(x);
        });
      dock.dispose();
      const shared: unknown[] = [lanternGlassGeometry, lanternMaterial];
      for (const x of made) expect(gone.has(x)).toBe(!shared.includes(x));
    }
  });
});
