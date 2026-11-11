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

type DuckPalette = {
  back: string;
  flank: string;
  chest: string;
  rear: string;
  head: string;
  bill: string;
  ring: string | null;
  patch: string;
};
/** A mallard drake: green head, white collar, chestnut chest, grey sides,
 * black behind, yellow bill — bold blocks of colour, which is what
 * reads when a duck is a dozen pixels long. */
const DRAKE: DuckPalette = {
  back: "#8d8578",
  flank: "#c4c2ba",
  chest: "#7d4026",
  rear: "#1d2027",
  head: "#1b8250",
  bill: "#f0cc3a",
  ring: "#f6f3ea",
  patch: "#2f5fb0",
};
/** And the hen: mottled brown all over, an orange bill. */
const HEN: DuckPalette = {
  back: "#7a5b3b",
  flank: "#9b7b54",
  chest: "#8d6c47",
  rear: "#5f4630",
  head: "#7d5f40",
  bill: "#dd8a2c",
  ring: null,
  patch: "#4a6fb8",
};

/** A duck: a plump, round body riding low, a big round head (herzie
 * proportions), a wide flat bill, an upturned tail, a wing patch, and a
 * pale ring of foam on the water round it. Along z (its heading), the
 * waterline at y 0. */
function duckGeometry(p: DuckPalette): THREE.BufferGeometry {
  const sphere = (r: number, sx: number, sy: number, sz: number) =>
    new THREE.SphereGeometry(r, 8, 6).scale(sx, sy, sz);
  const parts: THREE.BufferGeometry[] = [
    painted(sphere(0.22, 0.9, 0.62, 1.35).translate(0, 0.07, -0.02), p.back),
    painted(sphere(0.2, 0.86, 0.5, 1.1).translate(0, 0.02, 0.02), p.flank),
    painted(sphere(0.17, 0.85, 0.8, 0.9).translate(0, 0.1, 0.2), p.chest),
    painted(sphere(0.15, 0.85, 0.7, 0.9).translate(0, 0.08, -0.3), p.rear),
    // The tail, flicked up.
    painted(
      new THREE.ConeGeometry(0.07, 0.2, 4)
        .rotateX(-Math.PI / 2 + 0.7)
        .translate(0, 0.2, -0.46),
      p.rear,
    ),
    // A patch on the folded wing.
    painted(
      new THREE.BoxGeometry(0.08, 0.02, 0.14).translate(0.15, 0.2, -0.1),
      p.patch,
    ),
    painted(
      new THREE.BoxGeometry(0.08, 0.02, 0.14).translate(-0.15, 0.2, -0.1),
      p.patch,
    ),
    painted(sphere(0.15, 1, 1, 1).translate(0, 0.3, 0.27), p.head),
    // The bill: wide and flat, an oversized one reads from far off.
    painted(
      new THREE.BoxGeometry(0.15, 0.045, 0.17).translate(0, 0.27, 0.46),
      p.bill,
    ),
    painted(
      new THREE.SphereGeometry(0.036, 5, 4).translate(0.1, 0.34, 0.36),
      "#15171c",
    ),
    painted(
      new THREE.SphereGeometry(0.036, 5, 4).translate(-0.1, 0.34, 0.36),
      "#15171c",
    ),
    // Foam where it sits.
    painted(
      new THREE.RingGeometry(0.3, 0.46, 12)
        .rotateX(-Math.PI / 2)
        .scale(0.9, 1, 1.25)
        .translate(0, 0.01, 0),
      "#e6f1f7",
    ),
  ];
  if (p.ring) {
    parts.push(
      painted(
        new THREE.CylinderGeometry(0.095, 0.1, 0.045, 8).translate(
          0,
          0.2,
          0.24,
        ),
        p.ring,
      ),
    );
  }
  return mergeGeometries(parts) as THREE.BufferGeometry;
}
const DRAKE_GEO = duckGeometry(DRAKE);
const HEN_GEO = duckGeometry(HEN);
const duckMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
  side: THREE.DoubleSide,
});
/** Ducks are drawn this much bigger than they're built. */
const DUCK_SIZE = 1.15;

type Duck = {
  drake: boolean;
  /** Its place in its own mesh (drakes and hens are drawn apart). */
  slot: number;
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
const size = new THREE.Vector3(DUCK_SIZE, DUCK_SIZE, DUCK_SIZE);
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
        drake: i % 2 === 0,
        slot: 0,
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
  const drakes = useRef<THREE.InstancedMesh>(null);
  const hens = useRef<THREE.InstancedMesh>(null);
  const nDrakes = ducks.filter((d) => d.drake).length;

  useFrame(({ clock }, dt) => {
    const dm = drakes.current;
    const hm = hens.current;
    if (!dm || !hm) return;
    const t = clock.elapsedTime;
    const step = Math.min(dt, 0.1);
    const { x: px, z: pz } = ambient.uPlayer.value;
    const frozen = ambient.uIce.value > 0.5;
    let nd = 0;
    let nh = 0;
    ducks.forEach((d) => {
      const m = d.drake ? dm : hm;
      const i = d.drake ? nd++ : nh++;
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
      v.set(d.x, elevation(map, d.x, d.z) + SURFACE + 0.04 + bob, d.z);
      e.set(
        paddling * Math.sin(t * 6 + d.phase) * 0.04,
        d.heading,
        Math.sin(t * 1.1 + d.phase * 0.7) * 0.03,
      );
      q.setFromEuler(e);
      m4.compose(v, q, size);
      m.setMatrixAt(i, m4);
    });
    dm.instanceMatrix.needsUpdate = true;
    hm.instanceMatrix.needsUpdate = true;
  });

  if (ducks.length === 0) return null;
  return (
    <>
      <instancedMesh
        key={`d${nDrakes}`}
        ref={drakes}
        args={[DRAKE_GEO, duckMaterial, Math.max(1, nDrakes)]}
        frustumCulled={false}
        castShadow
      />
      <instancedMesh
        key={`h${ducks.length - nDrakes}`}
        ref={hens}
        args={[HEN_GEO, duckMaterial, Math.max(1, ducks.length - nDrakes)]}
        frustumCulled={false}
        castShadow
      />
    </>
  );
}
