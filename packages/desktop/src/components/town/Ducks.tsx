import { mulberry32 } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ambient } from "./ambient";
import {
  cellAt,
  cellCenter,
  elevation,
  isOpenWater,
  isSunk,
  type TownMap,
  terrainAt,
} from "./map";
import { painted } from "./parts";
import { SURFACE } from "./Water";

// Ducks on the ponds: a few paddling about on the open water, drifting
// from spot to spot, bobbing on the ripples, and paddling off (quicker)
// when you come to the bank. One instanced draw. Gone under the ice.

/** How many ducks a pond gets per open-water cell, and the most on an
 * island. */
const PER_CELL = 0.12;
const MAX_DUCKS = 12;
/** Paddling, and getting away from you. */
const PADDLE = 0.45;
const FLEE = 1.3;
/** You're this close: they paddle off. */
const SHY_RANGE = 3.6;
/** How far they'll go in one drift. */
const DRIFT = 3;
/** Resting between drifts (s). */
const REST = [2, 7] as const;
/** How quickly they turn (per second). */
const TURN = 3;

const BODY = "#8a6a44";
const HEAD = "#2f7a4a";
const BILL = "#e8b83a";
const CHEST = "#d9cdb8";

/** A duck: a plump body low on the water, a round head on a short neck,
 * a flat bill, a pale chest. Along z (its heading). */
const duckGeometry = (() => {
  const body = new THREE.SphereGeometry(0.2, 7, 5);
  body.scale(0.85, 0.6, 1.4);
  const chest = new THREE.SphereGeometry(0.16, 6, 4);
  chest.scale(0.8, 0.55, 1);
  chest.translate(0, -0.01, 0.12);
  const tail = new THREE.ConeGeometry(0.07, 0.16, 4);
  tail.rotateX(-Math.PI / 2 - 0.5);
  tail.translate(0, 0.08, -0.3);
  const head = new THREE.SphereGeometry(0.11, 7, 5);
  head.translate(0, 0.22, 0.2);
  const bill = new THREE.BoxGeometry(0.1, 0.035, 0.12);
  bill.translate(0, 0.19, 0.33);
  return mergeGeometries([
    painted(body, BODY),
    painted(chest, CHEST),
    painted(tail, BODY),
    painted(head, HEAD),
    painted(bill, BILL),
  ]) as THREE.BufferGeometry;
})();
const duckMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
});

type Duck = {
  x: number;
  z: number;
  heading: number;
  to: { x: number; z: number } | null;
  rest: number;
  speed: number;
  phase: number;
};

/** Water all the way from a to b: a duck never crosses a bank. */
function afloat(
  map: TownMap,
  a: { x: number; z: number },
  b: { x: number; z: number },
): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.3));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const [col, row] = cellAt(
      map,
      a.x + (b.x - a.x) * t,
      a.z + (b.z - a.z) * t,
    );
    if (!isSunk(terrainAt(map, col, row))) return false;
  }
  return true;
}

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const v = new THREE.Vector3();
const one = new THREE.Vector3(1, 1, 1);
const none = new THREE.Vector3(0, 0, 0);

export function Ducks({ map }: { map: TownMap }) {
  const water = useMemo(() => {
    const out: [number, number][] = [];
    for (let row = 0; row < map.size; row++) {
      for (let col = 0; col < map.size; col++) {
        if (isOpenWater(map, col, row)) out.push(cellCenter(map, col, row));
      }
    }
    return out;
  }, [map]);
  const rand = useMemo(() => mulberry32(map.size * 17 + 3), [map]);
  const ducks = useMemo<Duck[]>(() => {
    const n = Math.min(MAX_DUCKS, Math.floor(water.length * PER_CELL));
    // In little groups, as ducks are, rather than one to a pond.
    const groups = Array.from(
      { length: Math.ceil(n / 3) },
      () => water[Math.floor(rand() * water.length)],
    );
    return Array.from({ length: n }, (_, i) => {
      const [gx, gz] = groups[i % groups.length];
      const near = water.filter(([x, z]) => Math.hypot(x - gx, z - gz) < 2.5);
      const [x, z] = near[Math.floor(rand() * near.length)];
      return {
        x,
        z,
        heading: rand() * Math.PI * 2,
        to: null,
        rest: rand() * REST[1],
        speed: PADDLE,
        phase: rand() * 100,
      };
    });
  }, [water, rand]);
  const mesh = useRef<THREE.InstancedMesh>(null);

  useFrame(({ clock }, dt) => {
    const m = mesh.current;
    if (!m) return;
    const t = clock.elapsedTime;
    const step = Math.min(dt, 0.1);
    const { x: px, z: pz } = ambient.uPlayer.value;
    const frozen = ambient.uIce.value > 0.5;
    ducks.forEach((d, i) => {
      if (frozen) {
        m4.compose(none, q, none);
        m.setMatrixAt(i, m4);
        return;
      }
      const dx = d.x - px;
      const dz = d.z - pz;
      const near = Math.hypot(dx, dz) < SHY_RANGE;
      if (near && d.speed < FLEE) {
        // Away from you: the furthest of a few tries, if it's all water.
        let best: { x: number; z: number } | null = null;
        let far = Math.hypot(dx, dz);
        for (let k = 0; k < 8; k++) {
          const a = rand() * Math.PI * 2;
          const to = {
            x: d.x + Math.sin(a) * DRIFT,
            z: d.z + Math.cos(a) * DRIFT,
          };
          const dist = Math.hypot(to.x - px, to.z - pz);
          if (dist > far && afloat(map, d, to)) {
            far = dist;
            best = to;
          }
        }
        if (best) {
          d.to = best;
          d.speed = FLEE;
        }
      }
      if (d.to) {
        const tx = d.to.x - d.x;
        const tz = d.to.z - d.z;
        const dist = Math.hypot(tx, tz);
        const want = Math.atan2(tx, tz);
        let turn = want - d.heading;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        d.heading += Math.max(-TURN * step, Math.min(TURN * step, turn));
        const go = Math.min(dist, d.speed * step);
        d.x += Math.sin(d.heading) * go;
        d.z += Math.cos(d.heading) * go;
        if (dist <= 0.05) {
          d.to = null;
          d.rest = REST[0] + rand() * (REST[1] - REST[0]);
          d.speed = PADDLE;
        }
      } else {
        d.rest -= step;
        if (d.rest <= 0) {
          const a = rand() * Math.PI * 2;
          const to = {
            x: d.x + Math.sin(a) * (0.8 + rand() * (DRIFT - 0.8)),
            z: d.z + Math.cos(a) * (0.8 + rand() * (DRIFT - 0.8)),
          };
          if (afloat(map, d, to)) d.to = to;
          else d.rest = 0.5;
        }
      }
      // Riding the ripples (see Water: small and slow), nodding as it
      // paddles.
      const bob = Math.sin(t * 1.4 + d.phase) * 0.02;
      const paddling = d.to ? 1 : 0;
      v.set(d.x, elevation(map, d.x, d.z) + SURFACE + 0.1 + bob, d.z);
      e.set(
        paddling * Math.sin(t * 6 + d.phase) * 0.04,
        d.heading,
        Math.sin(t * 1.1 + d.phase * 0.7) * 0.03,
      );
      q.setFromEuler(e);
      m4.compose(v, q, one);
      m.setMatrixAt(i, m4);
    });
    m.instanceMatrix.needsUpdate = true;
  });

  if (ducks.length === 0) return null;
  return (
    <instancedMesh
      key={ducks.length}
      ref={mesh}
      args={[duckGeometry, duckMaterial, ducks.length]}
      frustumCulled={false}
      castShadow
    />
  );
}
