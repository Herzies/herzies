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

/** A bird's body: a slim teardrop along z (its heading), a small head
 * and beak, and a fanned tail. */
const bodyGeometry = (() => {
  const body = new THREE.SphereGeometry(0.15, 8, 6);
  body.scale(0.8, 0.72, 1.7);
  const head = new THREE.SphereGeometry(0.08, 6, 5);
  head.translate(0, 0.07, 0.27);
  const beak = new THREE.ConeGeometry(0.03, 0.12, 4);
  beak.rotateX(Math.PI / 2);
  beak.translate(0, 0.05, 0.4);
  // The tail: a flat wedge trailing behind, a little raised.
  const tail = new THREE.BufferGeometry();
  tail.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        -0.06, 0, -0.2, 0.06, 0, -0.2, 0.15, 0.01, -0.5, -0.06, 0, -0.2, 0.15,
        0.01, -0.5, -0.15, 0.01, -0.5, 0, 0, -0.2, 0, 0.01, -0.52, 0.06, 0,
        -0.2,
      ],
      3,
    ),
  );
  tail.computeVertexNormals();
  const g = mergeGeometries(
    [body, head, beak]
      .map((p) => {
        const out = p.toNonIndexed();
        out.deleteAttribute("uv");
        return out;
      })
      .concat(tail),
  ) as THREE.BufferGeometry;
  return g;
})();
/** Its wings: swept back to a pointed tip, mirrored either side, with
 * a bend point so they can flap (see `beat` in the material). */
const wingGeometry = (() => {
  const g = new THREE.BufferGeometry();
  const side = (m: number) => {
    const A = [0, 0, 0.12];
    const B = [m * 0.3, 0, 0.1];
    const C = [m * 0.68, 0.02, -0.2];
    const D = [0, 0, -0.16];
    const E = [m * 0.32, 0, -0.14];
    return m > 0
      ? [...A, ...B, ...E, ...A, ...E, ...D, ...B, ...C, ...E]
      : [...A, ...E, ...B, ...A, ...D, ...E, ...B, ...E, ...C];
  };
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([...side(1), ...side(-1)], 3),
  );
  g.computeVertexNormals();
  return g;
})();
/** Wings flap by lifting their outer parts: `beat` (per bird) is how far
 * up (or down, negative) the tips go. Applied before the bird's own
 * placement, so it turns and banks with it. */
const birdMaterial = new THREE.MeshLambertMaterial({
  flatShading: true,
  side: THREE.DoubleSide,
});
const wingMaterial = new THREE.MeshLambertMaterial({
  flatShading: true,
  side: THREE.DoubleSide,
});
wingMaterial.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nattribute float beat;")
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
float reach = abs( position.x );
transformed.y += reach * reach * 1.4 * beat;
transformed.z -= reach * abs( beat ) * 0.12;`,
    );
};
wingMaterial.customProgramCacheKey = () => "bird-wing";

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

/** The flight from one perch to another: a quick climb, a long glide
 * and a flared landing — not a symmetrical hump. */
function flightPoint(
  a: Perch,
  b: Perch,
  k: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  const arc = Math.min(CROW_ARC, 1.4 + dist * 0.22);
  // Along the ground: away fast, easing into the landing.
  const e = 1 - (1 - k) ** 1.7;
  // Up early, then sinking the rest of the way in.
  const lift = Math.sin(Math.PI * Math.min(1, k ** 0.6)) * arc;
  return out.set(
    a.x + (b.x - a.x) * e,
    a.y + (b.y - a.y) * k + lift,
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
  const wingGeo = useMemo(() => {
    const g = wingGeometry.clone();
    g.setAttribute(
      "beat",
      new THREE.InstancedBufferAttribute(new Float32Array(count), 1),
    );
    return g;
  }, [count]);
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
              1.6,
              Math.hypot(a.x - b.x, a.z - b.z) / CROW_SPEED + 0.8,
            );
          }
          c.restless = RESTLESS[0] + rand() * (RESTLESS[1] - RESTLESS[0]);
        }
      }
      let beat = -1.3;
      let pitch = 0;
      if (c.to >= 0) {
        const a = perches[c.perch];
        const b = perches[c.to];
        c.flight += step / c.duration;
        const k = Math.min(1, c.flight);
        flightPoint(a, b, k, v);
        flightPoint(a, b, Math.min(1, k + 0.03), v2);
        c.x = v.x;
        c.y = v.y;
        c.z = v.z;
        if (k < 1) {
          const run = Math.hypot(v2.x - v.x, v2.z - v.z);
          if (run > 1e-4) c.heading = Math.atan2(v2.x - v.x, v2.z - v.z);
          pitch = Math.atan2(v2.y - v.y, Math.max(run, 1e-3)) * 0.8;
        }
        // Beating hard to climb, a few flaps in the glide, a flare at
        // the end.
        const flaps =
          k < 0.4 || k > 0.85
            ? 1
            : 0.25 + 0.75 * Math.max(0, Math.sin(t * 2 + c.phase));
        beat = Math.sin(t * 13 + c.phase) * 0.9 * flaps + (1 - flaps) * 0.25;
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
        pitch,
        beat,
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
      const weave = Math.sin(t * 0.5 + j * 0.9);
      const y = f.y + Math.sin(t * 1.1 + j) * 0.4;
      // Flapping in bursts, gliding between (each bird its own rhythm).
      const going = Math.max(
        0,
        Math.min(1, (Math.sin(t * 0.9 + j * 1.7) + 0.5) * 2),
      );
      const beat = Math.sin(t * 10 + j * 0.8) * 0.8 * going + (1 - going) * 0.2;
      place(
        body,
        wing,
        i,
        x - f.dz * weave * 0.3,
        y,
        z + f.dx * weave * 0.3,
        heading + weave * 0.05,
        Math.cos(t * 1.1 + j) * 0.05,
        beat,
        0.8,
      );
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
        args={[wingGeo, wingMaterial, count]}
        frustumCulled={false}
        castShadow
      />
    </>
  );
}

/** Sets a bird's body and wings: nose pitched by `pitch`, wing tips
 * lifted by `beat` (negative: folded down along the back). */
function place(
  body: THREE.InstancedMesh,
  wing: THREE.InstancedMesh,
  i: number,
  x: number,
  y: number,
  z: number,
  heading: number,
  pitch: number,
  beat: number,
  size: number,
) {
  v.set(x, y, z);
  e.set(-pitch, heading, 0, "YXZ");
  q.setFromEuler(e);
  scale.setScalar(size);
  m4.compose(v, q, scale);
  body.setMatrixAt(i, m4);
  // Folded wings are narrow as well as down.
  scale.set(beat < -1 ? 0.35 * size : size, size, size);
  m4.compose(v, q, scale);
  wing.setMatrixAt(i, m4);
  const attr = wing.geometry.attributes.beat as THREE.BufferAttribute;
  attr.setX(i, beat);
  attr.needsUpdate = true;
}
