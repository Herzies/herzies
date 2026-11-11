import { mulberry32 } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ambient } from "./ambient";
import { type Perch, ridgePerchesOf } from "./Buildings";
import {
  groundY,
  islandRadius,
  objectAt,
  objectJitter,
  type TownMap,
} from "./map";

// The birds: crows sitting about on the roof ridges and the lamp posts,
// which lift off and settle somewhere else when you walk up to them (or
// just because), and now and then a flock of something smaller crossing
// high over the island in a V. All of them two draw calls — bodies and
// wings, instanced — moved on the CPU: there are a dozen.

/** How many crows live on an island, at most (fewer on one with few
 * perches). */
const MAX_CROWS = 6;
/** How many in a flock, and how often one comes over (s, give or take). */
const FLOCK = 7;
const FLOCK_EVERY = 150;
const FLOCK_SPREAD = 90;
/** How fast a flock flies, and how high. */
const FLOCK_SPEED = 5.5;
const FLOCK_HEIGHT = [13, 20] as const;
/** A crow lifts off when you're this close. */
const SCARE_RANGE = 3.2;
/** Left alone, a crow moves on by itself after this long (s). */
const RESTLESS = [40, 110] as const;
/** How fast a crow flies between perches, and how high it arcs over
 * the way. */
const CROW_SPEED = 6;
const CROW_ARC = 5;
/** The top of a lamp post, as a perch (see lampPostGeometry's cap). */
const LAMP_CAP_Y = 3.72;

const CROW = "#23242a";
const FLOCK_COLOR = "#2d2f38";

/** A bird's body: a blunt teardrop along z (its heading), with a head.
 * Big for a crow — everything here is, next to a herzie. */
const bodyGeometry = (() => {
  const body = new THREE.SphereGeometry(0.17, 7, 5);
  body.scale(0.85, 0.8, 1.6);
  const head = new THREE.SphereGeometry(0.1, 6, 4);
  head.translate(0, 0.12, 0.22);
  const beak = new THREE.ConeGeometry(0.035, 0.12, 4);
  beak.rotateX(Math.PI / 2);
  beak.translate(0, 0.11, 0.36);
  const g = mergeGeometries(
    [body, head, beak].map((p) => {
      const out = p.toNonIndexed();
      out.deleteAttribute("uv");
      return out;
    }),
  ) as THREE.BufferGeometry;
  return g;
})();
/** Its wings: a pair out to either side, meeting at the body. */
const wingGeometry = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        0, 0, 0.1, 0.55, 0.03, -0.14, 0.5, 0.03, 0.16, 0, 0, 0.1, -0.5, 0.03,
        0.16, -0.55, 0.03, -0.14,
      ],
      3,
    ),
  );
  g.computeVertexNormals();
  return g;
})();
const birdMaterial = new THREE.MeshLambertMaterial({
  flatShading: true,
  side: THREE.DoubleSide,
});

/** Where the crows can sit on this island: the roof ridges and the tops
 * of the lamp posts. */
export function perchesOf(map: TownMap): Perch[] {
  const out = ridgePerchesOf(map);
  for (let row = 0; row < map.size; row++) {
    for (let col = 0; col < map.size; col++) {
      if (objectAt(map, col, row) !== "L") continue;
      const { x, z, scale, yaw } = objectJitter(map, col, row);
      out.push({ x, y: groundY(map, x, z) + LAMP_CAP_Y * scale, z, yaw });
    }
  }
  return out;
}

type Crow = {
  /** Which perch it's on (or left). */
  perch: number;
  /** Where it's flying to, or -1 when sitting. */
  to: number;
  /** How far along the flight, 0–1. */
  flight: number;
  /** How long this flight takes (s). */
  duration: number;
  /** Seconds until it moves on of its own accord. */
  restless: number;
  phase: number;
  /** Where it is, and where it's facing. */
  x: number;
  y: number;
  z: number;
  heading: number;
};

/** The flight from one perch to another: an arc up and over, eased so
 * it springs off and glides in. */
function flightPoint(
  a: Perch,
  b: Perch,
  k: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const e = k * k * (3 - 2 * k);
  const lift = Math.sin(k * Math.PI) * CROW_ARC;
  return out.set(
    a.x + (b.x - a.x) * e,
    a.y + (b.y - a.y) * e + lift,
    a.z + (b.z - a.z) * e,
  );
}

/** Picks a perch for a crow to fly to: free, and some way off. */
function nextPerch(
  perches: Perch[],
  taken: Set<number>,
  from: number,
  rand: () => number,
): number {
  const a = perches[from];
  for (let tries = 0; tries < 8; tries++) {
    const i = Math.floor(rand() * perches.length);
    if (i === from || taken.has(i)) continue;
    const b = perches[i];
    if (Math.hypot(a.x - b.x, a.z - b.z) < 5 && tries < 6) continue;
    return i;
  }
  return -1;
}

/** Everything the birds need per frame, so nothing's allocated. */
const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const v = new THREE.Vector3();
const v2 = new THREE.Vector3();
const scale = new THREE.Vector3();
const hidden = new THREE.Vector3(0, 0, 0);

export function Birds({ map }: { map: TownMap }) {
  const perches = useMemo(() => perchesOf(map), [map]);
  const rand = useMemo(() => mulberry32(map.size * 31 + 7), [map]);
  const crows = useMemo<Crow[]>(() => {
    const n = Math.min(MAX_CROWS, Math.floor(perches.length / 2));
    const taken = new Set<number>();
    return Array.from({ length: n }, () => {
      let perch = Math.floor(rand() * perches.length);
      while (taken.has(perch)) perch = (perch + 1) % perches.length;
      taken.add(perch);
      const p = perches[perch];
      return {
        perch,
        to: -1,
        flight: 0,
        duration: 1,
        restless: RESTLESS[0] + rand() * (RESTLESS[1] - RESTLESS[0]),
        phase: rand() * 100,
        x: p.x,
        y: p.y,
        z: p.z,
        heading: p.yaw,
      };
    });
  }, [perches, rand]);
  const radius = islandRadius(map);
  /** The flock: when it next sets out, from where, which way. */
  const flock = useRef({
    at: 30 + Math.random() * 30,
    started: Number.NaN,
    x0: 0,
    z0: 0,
    dx: 0,
    dz: 0,
    y: 15,
    length: 0,
  });
  const bodies = useRef<THREE.InstancedMesh>(null);
  const wings = useRef<THREE.InstancedMesh>(null);
  const count = crows.length + FLOCK;
  useLayoutEffect(() => {
    const c = new THREE.Color();
    for (const mesh of [bodies.current, wings.current]) {
      if (!mesh) continue;
      for (let i = 0; i < count; i++) {
        mesh.setColorAt(i, c.set(i < crows.length ? CROW : FLOCK_COLOR));
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }, [count, crows.length]);

  useFrame(({ clock }, dt) => {
    const body = bodies.current;
    const wing = wings.current;
    if (!body || !wing) return;
    const t = clock.elapsedTime;
    const step = Math.min(dt, 0.1);
    const { x: px, z: pz } = ambient.uPlayer.value;
    const taken = new Set(crows.map((c) => (c.to >= 0 ? c.to : c.perch)));

    // The crows.
    crows.forEach((c, i) => {
      if (c.to < 0) {
        const near = Math.hypot(c.x - px, c.z - pz) < SCARE_RANGE;
        c.restless -= step;
        if (near || c.restless <= 0) {
          const to = nextPerch(perches, taken, c.perch, rand);
          if (to >= 0) {
            taken.add(to);
            const a = perches[c.perch];
            const b = perches[to];
            c.to = to;
            c.flight = 0;
            c.duration = Math.max(
              1.8,
              Math.hypot(a.x - b.x, a.z - b.z) / CROW_SPEED + 1,
            );
          }
          c.restless = RESTLESS[0] + rand() * (RESTLESS[1] - RESTLESS[0]);
        }
      }
      let flap = 0;
      if (c.to >= 0) {
        const a = perches[c.perch];
        const b = perches[c.to];
        c.flight += step / c.duration;
        const k = Math.min(1, c.flight);
        flightPoint(a, b, k, v);
        flightPoint(a, b, Math.min(1, k + 0.02), v2);
        c.x = v.x;
        c.y = v.y;
        c.z = v.z;
        if (k < 1) c.heading = Math.atan2(v2.x - v.x, v2.z - v.z);
        // Beating hard on the way up, gliding down.
        flap = k < 0.55 ? 1 : 0.35;
        if (k >= 1) {
          c.perch = c.to;
          c.to = -1;
          c.heading = b.yaw;
        }
      }
      // Sitting: a hop of the head now and then.
      const bob =
        c.to < 0 ? Math.max(0, Math.sin(t * 1.3 + c.phase)) ** 12 * 0.04 : 0;
      place(
        body,
        wing,
        i,
        c.x,
        c.y + bob + 0.14,
        c.z,
        c.heading,
        flap,
        t,
        c.phase,
        1,
      );
    });

    // The flock.
    const f = flock.current;
    const flying =
      (1 - THREE.MathUtils.smoothstep(ambient.uNight.value, 0.3, 0.6)) *
      (1 - ambient.uRain.value) *
      (1 - ambient.uSnow.value);
    if (Number.isNaN(f.started)) {
      if (t >= f.at) {
        if (flying < 0.5) f.at = t + 30;
        else {
          // Across the island, from one side to the other, well clear of it.
          const a = Math.random() * Math.PI * 2;
          const r = radius + 25;
          f.x0 = Math.cos(a) * r;
          f.z0 = Math.sin(a) * r;
          const b = a + Math.PI + (Math.random() - 0.5) * 1.2;
          f.dx = Math.cos(b) * r - f.x0;
          f.dz = Math.sin(b) * r - f.z0;
          f.length = Math.hypot(f.dx, f.dz);
          f.dx /= f.length;
          f.dz /= f.length;
          f.y =
            FLOCK_HEIGHT[0] +
            Math.random() * (FLOCK_HEIGHT[1] - FLOCK_HEIGHT[0]);
          f.started = t;
        }
      }
    }
    const along = Number.isNaN(f.started) ? -1 : (t - f.started) * FLOCK_SPEED;
    if (along > f.length + 10) {
      f.started = Number.NaN;
      f.at = t + FLOCK_EVERY + (Math.random() - 0.5) * FLOCK_SPREAD;
    }
    const heading = Math.atan2(f.dx, f.dz);
    for (let j = 0; j < FLOCK; j++) {
      const i = crows.length + j;
      if (along < 0) {
        m4.compose(hidden, q, hidden);
        body.setMatrixAt(i, m4);
        wing.setMatrixAt(i, m4);
        continue;
      }
      // A V: the leader in front, the rest back and out to either side.
      const rank = Math.ceil(j / 2);
      const side = j === 0 ? 0 : j % 2 === 0 ? 1 : -1;
      const back = rank * 1.1;
      const out = rank * 0.9 * side;
      const x = f.x0 + f.dx * (along - back) - f.dz * out;
      const z = f.z0 + f.dz * (along - back) + f.dx * out;
      const y = f.y + Math.sin(t * 1.1 + j) * 0.3;
      place(body, wing, i, x, y, z, heading, 0.8, t, j * 0.7, 1.15);
    }
    body.instanceMatrix.needsUpdate = true;
    wing.instanceMatrix.needsUpdate = true;
  });

  if (perches.length === 0) return null;
  return (
    <>
      <instancedMesh
        key={`b${count}`}
        ref={bodies}
        args={[bodyGeometry, birdMaterial, count]}
        frustumCulled={false}
        castShadow
      />
      <instancedMesh
        key={`w${count}`}
        ref={wings}
        args={[wingGeometry, birdMaterial, count]}
        frustumCulled={false}
        castShadow
      />
    </>
  );
}

/** Sets a bird's body and wings: `flap` 0 for folded wings, up to 1 for
 * beating hard. */
function place(
  body: THREE.InstancedMesh,
  wing: THREE.InstancedMesh,
  i: number,
  x: number,
  y: number,
  z: number,
  heading: number,
  flap: number,
  t: number,
  phase: number,
  size: number,
) {
  v.set(x, y, z);
  e.set(0, heading, 0);
  q.setFromEuler(e);
  scale.setScalar(size);
  m4.compose(v, q, scale);
  body.setMatrixAt(i, m4);
  if (flap <= 0) {
    // Folded: tucked flat and narrow along the back.
    e.set(0, heading, 0);
    q.setFromEuler(e);
    scale.set(0.35 * size, size, 0.9 * size);
    v.y += 0.03;
  } else {
    // Beating: the wings roll about the body's axis.
    const beat = Math.sin(t * (flap > 0.5 ? 14 : 6) + phase) * 0.7 * flap;
    e.set(0, heading, beat);
    q.setFromEuler(e);
    scale.set(size, size, size);
  }
  m4.compose(v, q, scale);
  wing.setMatrixAt(i, m4);
}
