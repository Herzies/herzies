import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { lanternMaterial, windowMaterial } from "../Buildings";
import { lanternGlassGeometry } from "../Lamps";
import {
  AirshipModel,
  ENVELOPE_BOTTOM,
  gangplankPose,
  SHIP_AT_REST,
  type ShipMotion,
} from "./AirshipModel";
import { DECK_OBSTACLES, DECK_OUTLINE, GANGWAY, onDeck } from "./deck";

/** Moored at a pier, everything out. */
const MOORED: ShipMotion = {
  ...SHIP_AT_REST,
  moored: 1,
  gangplank: 1,
  gangplankTo: { x: 9.5, y: -1.3 },
};

const drawn = (root: THREE.Object3D) => {
  let n = 0;
  root.traverseVisible((o) => {
    if ((o as THREE.Mesh).isMesh) n++;
  });
  return n;
};

/** How far (x, z) is inside the rail. */
function inside(x: number, z: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < DECK_OUTLINE.length; i++) {
    const [x0, z0] = DECK_OUTLINE[i];
    const [x1, z1] = DECK_OUTLINE[(i + 1) % DECK_OUTLINE.length];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const t = Math.max(
      0,
      Math.min(1, ((x - x0) * dx + (z - z0) * dz) / (dx * dx + dz * dz)),
    );
    best = Math.min(best, Math.hypot(x - x0 - t * dx, z - z0 - t * dz));
  }
  return onDeck(x, z) ? best : -best;
}

/** Points on every triangle a mesh draws (its corners, along its edges,
 * its middle), in the ship's frame. */
function* pointsOf(mesh: THREE.Mesh): Generator<THREE.Vector3> {
  const pos = mesh.geometry.attributes.position;
  const index = mesh.geometry.index;
  const count = index ? index.count : pos.count;
  const range = mesh.geometry.drawRange;
  const end = Math.min(count, range.start + range.count);
  const instances = (mesh as THREE.InstancedMesh).isInstancedMesh
    ? (mesh as THREE.InstancedMesh).count
    : 1;
  mesh.updateMatrix();
  const corner = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];
  const m = new THREE.Matrix4();
  for (let k = 0; k < instances; k++) {
    if ((mesh as THREE.InstancedMesh).isInstancedMesh)
      (mesh as THREE.InstancedMesh).getMatrixAt(k, m);
    else m.identity();
    m.premultiply(mesh.matrix);
    for (let i = range.start; i + 2 < end; i += 3) {
      for (let c = 0; c < 3; c++) {
        const v = index ? index.getX(i + c) : i + c;
        corner[c].fromBufferAttribute(pos, v).applyMatrix4(m);
      }
      for (let c = 0; c < 3; c++)
        for (let s = 0; s < 8; s++)
          yield corner[c].clone().lerp(corner[(c + 1) % 3], s / 8);
      yield corner[0].clone().add(corner[1]).add(corner[2]).divideScalar(3);
    }
  }
}

describe("AirshipModel", () => {
  it("draws in at most 10 calls, fewer in flight", () => {
    const ship = new AirshipModel();
    ship.update(1 / 60, 10, MOORED);
    expect(drawn(ship.root)).toBeLessThanOrEqual(10);
    ship.update(1 / 60, 10, { ...SHIP_AT_REST, speed: 6.5, throttle: 1 });
    expect(drawn(ship.root)).toBeLessThanOrEqual(9);
    ship.dispose();
  });

  it("leaves the deck clear to walk, but for the helm and the bell post", () => {
    const ship = new AirshipModel();
    ship.update(1 / 60, 3, MOORED);
    const blocking: string[] = [];
    ship.root.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const p of pointsOf(mesh)) {
        // Where a herzie (~0.5 round, ~2.4 tall) can stand on deck…
        if (p.y < 0.15 || p.y > 2.4 || inside(p.x, p.z) < 0.45) continue;
        // …that isn't the helm or the bell post.
        if (
          DECK_OBSTACLES.some(
            (b) => Math.hypot(p.x - b.x, p.z - b.z) < b.r + 0.12,
          )
        )
          continue;
        blocking.push(`${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`);
        return;
      }
    });
    expect(blocking).toEqual([]);
    ship.dispose();
  });

  it("keeps its balloon above where the camera goes", () => {
    expect(ENVELOPE_BOTTOM).toBeGreaterThanOrEqual(11);
  });

  it("disposes everything it made, and nothing the town shares", () => {
    const ship = new AirshipModel();
    ship.update(1 / 60, 1, MOORED);
    const made = new Set<THREE.BufferGeometry | THREE.Material>();
    ship.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      made.add(mesh.geometry);
      for (const m of [mesh.material].flat()) made.add(m);
    });
    const shared = [lanternGlassGeometry, lanternMaterial, windowMaterial];
    const gone = new Set<unknown>();
    for (const x of made)
      x.addEventListener("dispose", () => {
        gone.add(x);
      });
    ship.dispose();
    for (const x of made)
      expect(gone.has(x)).toBe(!shared.includes(x as never));
    expect(ship.root.children).toHaveLength(0);
  });
});

describe("gangplankPose", () => {
  const to = { x: 10.2, y: -1.3 };
  it("comes to rest at its end, out past the gangway", () => {
    const p = gangplankPose(1, to);
    expect(p.x + p.length * Math.cos(p.pitch)).toBeCloseTo(to.x, 5);
    expect(p.y + p.length * Math.sin(p.pitch)).toBeCloseTo(to.y, 5);
    expect(p.x).toBeGreaterThanOrEqual(GANGWAY.x);
    expect(p.rise).toBe(1);
  });
  it("stows inside the hull, level, its rails down", () => {
    const p = gangplankPose(0, to);
    expect(p.x + p.length).toBeLessThanOrEqual(GANGWAY.x + 0.25);
    expect(p.x).toBeGreaterThan(-GANGWAY.x - 0.25);
    expect(p.pitch).toBeCloseTo(0, 9);
    expect(p.rise).toBe(0);
  });
  it("only tips once it's slid all the way out", () => {
    const sliding = gangplankPose(0.4, to);
    expect(sliding.pitch).toBeCloseTo(0, 9);
    expect(gangplankPose(0.6, to).x).toBeCloseTo(gangplankPose(1, to).x, 5);
  });
  it("slides in and out under the deck, its cleats (0.035 up) too", () => {
    for (const g of [0, 0.3, 0.6])
      expect(gangplankPose(g, to).y + 0.035).toBeLessThan(0);
  });
});
