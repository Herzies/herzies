import { mulberry32 } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ambient } from "./ambient";
import { type Perch, ridgePerchesOf } from "./Buildings";
import {
  type Bird,
  FLIGHT,
  isPerched,
  type Pose,
  perchedBird,
  startFlight,
  stepBird,
  wingWave,
} from "./birdFlight";
import {
  groundY,
  islandRadius,
  objectAt,
  objectJitter,
  type TownMap,
} from "./map";
import { painted } from "./parts";

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
/** The top of a lamp post, as a perch (see lampPostGeometry's cap). */
const LAMP_CAP_Y = 3.88;

type Palette = {
  back: string;
  belly: string;
  head: string;
  beak: string;
  eye: string;
  tail: string;
  legs: string;
  wing: string;
  wingTip: string;
};

/** Crows: sooty, with a pale eye and a yellow beak — the beak and the eye
 * are what read at the Town's big pixels, so they're oversized. */
const CROW: Palette = {
  back: "#3b3d4b",
  belly: "#5b5e70",
  head: "#454757",
  beak: "#e8b13c",
  eye: "#f6f3e8",
  tail: "#272830",
  legs: "#5a452c",
  wing: "#454758",
  wingTip: "#1e1f27",
};
/** Gulls: white against the sky, black wing tips, a yellow beak. */
const GULL: Palette = {
  back: "#eceef2",
  belly: "#ffffff",
  head: "#ffffff",
  beak: "#f2b134",
  eye: "#1c1e24",
  tail: "#e2e5ea",
  legs: "#e0903a",
  wing: "#e8eaef",
  wingTip: "#2c313d",
};

/** A bird, chunky and cute like the herzies — round, a big head, an
 * oversized beak and eyes, since a few pixels is all it gets: a body in
 * two tones (back and belly), a fanned tail, little legs. Standing on
 * the origin, facing +z. */
function birdGeometry(p: Palette): THREE.BufferGeometry {
  const lift = 0.25;
  const at = (g: THREE.BufferGeometry, color: string) =>
    painted(g.translate(0, lift, 0), color);
  const sphere = (r: number, sx: number, sy: number, sz: number) =>
    new THREE.SphereGeometry(r, 8, 6).scale(sx, sy, sz);
  const eyeAt = (side: number) =>
    new THREE.SphereGeometry(0.04, 5, 4).translate(side * 0.09, 0.16, 0.27);
  const tail = new THREE.BufferGeometry();
  tail.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        -0.08, 0, -0.18, 0.08, 0, -0.18, 0.2, 0.02, -0.56, -0.08, 0, -0.18, 0.2,
        0.02, -0.56, -0.2, 0.02, -0.56, -0.08, 0, -0.18, -0.2, 0.02, -0.56, 0,
        0.03, -0.6, 0.08, 0, -0.18, 0, 0.03, -0.6, 0.2, 0.02, -0.56,
      ],
      3,
    ),
  );
  tail.computeVertexNormals();
  const leg = (side: number) =>
    new THREE.CylinderGeometry(0.014, 0.014, 0.14, 4).translate(
      side * 0.055,
      -0.18,
      0.02,
    );
  return mergeGeometries([
    at(sphere(0.18, 0.85, 0.82, 1.4), p.back),
    at(sphere(0.17, 0.82, 0.62, 1.2).translate(0, -0.06, 0.04), p.belly),
    at(sphere(0.13, 1, 1, 1).translate(0, 0.14, 0.21), p.head),
    at(
      new THREE.ConeGeometry(0.05, 0.16, 5)
        .rotateX(Math.PI / 2)
        .translate(0, 0.12, 0.37),
      p.beak,
    ),
    at(eyeAt(1), p.eye),
    at(eyeAt(-1), p.eye),
    at(tail, p.tail),
    at(leg(1), p.legs),
    at(leg(-1), p.legs),
  ]) as THREE.BufferGeometry;
}

/** Wings, swept back to a pointed tip, mirrored either side, the outer
 * part darker; the vertices past the shoulder lift to flap (see
 * `beat` in the material). */
/** How high the wings' roots are above the feet (see birdGeometry's lift). */
const SHOULDER = 0.29;

function wingGeometry(p: Palette): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const side = (m: number) => {
    const A = [0, 0, 0.16];
    const B = [m * 0.34, 0, 0.14];
    const C = [m * 0.8, 0.02, -0.24];
    const D = [0, 0, -0.22];
    const E = [m * 0.4, 0, -0.2];
    return m > 0
      ? [...A, ...B, ...E, ...A, ...E, ...D, ...B, ...C, ...E]
      : [...A, ...E, ...B, ...A, ...D, ...E, ...B, ...E, ...C];
  };
  // Hinged on the body's shoulders, which sit this high off the feet.
  const pos = [...side(1), ...side(-1)].map((v, i) =>
    i % 3 === 1 ? v + SHOULDER : v,
  );
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const inner = new THREE.Color(p.wing);
  const tip = new THREE.Color(p.wingTip);
  const c = new THREE.Color();
  const colors: number[] = [];
  for (let i = 0; i < pos.length; i += 3) {
    c.copy(inner).lerp(
      tip,
      THREE.MathUtils.smoothstep(Math.abs(pos[i]), 0.3, 0.8),
    );
    colors.push(c.r, c.g, c.b);
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

const flatLit = () =>
  new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    side: THREE.DoubleSide,
  });
const birdMaterial = flatLit();
/** Wings flap by lifting their outer parts: `beat` (per bird) is how far
 * up (or down, negative) the tips go. Applied before the bird's own
 * placement, so it turns and banks with it. */
const wingMaterial = flatLit();
wingMaterial.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nattribute vec2 beat;")
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
float reach = abs( position.x );
// The shoulder's beat out to the tip's, which comes a moment later.
float lift = mix( beat.x, beat.y, smoothstep( 0.2, 0.75, reach ) );
transformed.y += reach * reach * 1.3 * lift;
transformed.z -= reach * abs( lift ) * 0.12;`,
    );
};
wingMaterial.customProgramCacheKey = () => "bird-wing";

const CROW_BODY = birdGeometry(CROW);
const CROW_WING = wingGeometry(CROW);
const GULL_BODY = birdGeometry(GULL);
const GULL_WING = wingGeometry(GULL);

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

/** A crow: its flight state (see birdFlight.ts), and the island's side
 * of it — which perch it's on or heading for, and when it'll move on. */
type Crow = {
  bird: Bird;
  /** The perch it's on, or left. */
  perch: number;
  /** The perch it's heading for, or -1 when sitting. */
  to: number;
  /** Seconds until it moves on of its own accord. */
  restless: number;
};

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
const scale = new THREE.Vector3();
const hidden = new THREE.Vector3(0, 0, 0);
/** The flock's birds' pose, one at a time. */
const flockPose: Pose = {
  x: 0,
  y: 0,
  z: 0,
  heading: 0,
  pitch: 0,
  roll: 0,
  beat: 0,
  tip: 0,
  spread: 1,
};

export function Birds({ map }: { map: TownMap }) {
  const perches = useMemo(() => perchesOf(map), [map]);
  const rand = useMemo(() => mulberry32(map.size * 31 + 7), [map]);
  const crows = useMemo<Crow[]>(() => {
    const n = Math.min(MAX_CROWS, Math.floor(perches.length / 2));
    const taken = new Set<number>();
    return Array.from({ length: n }, (_, i) => {
      let perch = Math.floor(rand() * perches.length);
      while (taken.has(perch)) perch = (perch + 1) % perches.length;
      taken.add(perch);
      return {
        bird: perchedBird(perches[perch], i * 7.31 + rand() * 5, rand),
        perch,
        to: -1,
        restless: RESTLESS[0] + rand() * (RESTLESS[1] - RESTLESS[0]),
      };
    });
  }, [perches, rand]);
  /** Where each gull's wings are in their beat. */
  const gullBeat = useRef(
    Float64Array.from({ length: FLOCK }, (_, j) => j * 0.37),
  );
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
  const crowBody = useRef<THREE.InstancedMesh>(null);
  const crowWing = useRef<THREE.InstancedMesh>(null);
  const gullBody = useRef<THREE.InstancedMesh>(null);
  const gullWing = useRef<THREE.InstancedMesh>(null);
  const nCrows = crows.length;
  /** The wings, each with its own per-bird flap (see wingMaterial). */
  const crowWingGeo = useMemo(
    () => withBeat(CROW_WING, Math.max(1, nCrows)),
    [nCrows],
  );
  const gullWingGeo = useMemo(() => withBeat(GULL_WING, FLOCK), []);

  useFrame(({ clock }, dt) => {
    const body = crowBody.current;
    const wing = crowWing.current;
    const gBody = gullBody.current;
    const gWing = gullWing.current;
    if (!body || !wing || !gBody || !gWing) return;
    const t = clock.elapsedTime;
    const step = Math.min(dt, 0.1);
    const { x: px, z: pz } = ambient.uPlayer.value;
    const taken = new Set(crows.map((c) => (c.to >= 0 ? c.to : c.perch)));

    // The crows.
    crows.forEach((c, i) => {
      const b = c.bird;
      if (isPerched(b)) {
        // Back on a perch (or never left).
        if (c.to >= 0) {
          c.perch = c.to;
          c.to = -1;
        }
        const near = Math.hypot(b.x - px, b.z - pz) < SCARE_RANGE;
        const flushed = b.flushIn <= 0;
        c.restless -= step;
        if (near || flushed || c.restless <= 0) {
          const to = nextPerch(perches, taken, c.perch, rand);
          const startled = near || flushed;
          if (to >= 0 && startFlight(b, perches[to], startled, rand)) {
            c.to = to;
            taken.add(to);
            // The neighbours go a beat after.
            if (startled) {
              for (const o of crows) {
                if (o === c || !isPerched(o.bird)) continue;
                if (o.bird.flushIn !== Number.POSITIVE_INFINITY) continue;
                const d = Math.hypot(o.bird.x - b.x, o.bird.z - b.z);
                if (d < FLIGHT.flushRange) {
                  o.bird.flushIn =
                    FLIGHT.flushDelay[0] +
                    rand() * (FLIGHT.flushDelay[1] - FLIGHT.flushDelay[0]);
                }
              }
            }
          } else if (flushed) b.flushIn = Number.POSITIVE_INFINITY;
          c.restless = RESTLESS[0] + rand() * (RESTLESS[1] - RESTLESS[0]);
        }
      }
      place(body, wing, i, stepBird(b, step, rand), 1);
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
      if (along < 0) {
        m4.compose(hidden, q, hidden);
        gBody.setMatrixAt(j, m4);
        gWing.setMatrixAt(j, m4);
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
      // Flapping in bursts, gliding between (each bird its own rhythm
      // and its own place in the beat, so the flock isn't in step).
      const going = THREE.MathUtils.clamp(
        (Math.sin(t * 0.9 + j * 1.7) + 0.5) * 2,
        0,
        1,
      );
      gullBeat.current[j] += (8 + (j % 3) * 0.7) * step;
      const phase = gullBeat.current[j];
      const amp = 0.85 * going;
      const off = 0.2 * (1 - going);
      const pose = flockPose;
      pose.x = x - f.dz * weave * 0.3;
      pose.y = y - wingWave(phase - 0.2) * 0.03 * amp;
      pose.z = z + f.dx * weave * 0.3;
      pose.heading = heading + weave * 0.05;
      pose.pitch = Math.cos(t * 1.1 + j) * 0.05;
      // Banking a little into the weave.
      pose.roll = -Math.cos(t * 0.5 + j * 0.9) * 0.12;
      pose.beat = wingWave(phase) * amp + off;
      pose.tip = wingWave(phase - 0.14) * amp * 1.1 + off;
      pose.spread = 1;
      place(gBody, gWing, j, pose, 1.35);
    }
    for (const m of [body, wing, gBody, gWing]) {
      m.instanceMatrix.needsUpdate = true;
    }
  });

  if (perches.length === 0) return null;
  return (
    <>
      <instancedMesh
        key={`cb${nCrows}`}
        ref={crowBody}
        args={[CROW_BODY, birdMaterial, Math.max(1, nCrows)]}
        frustumCulled={false}
        castShadow
      />
      <instancedMesh
        key={`cw${nCrows}`}
        ref={crowWing}
        args={[crowWingGeo, wingMaterial, Math.max(1, nCrows)]}
        frustumCulled={false}
        castShadow
      />
      <instancedMesh
        ref={gullBody}
        args={[GULL_BODY, birdMaterial, FLOCK]}
        frustumCulled={false}
        castShadow
      />
      <instancedMesh
        ref={gullWing}
        args={[gullWingGeo, wingMaterial, FLOCK]}
        frustumCulled={false}
        castShadow
      />
    </>
  );
}

/** A wing geometry with a per-bird flap attribute for `count` birds. */
function withBeat(wing: THREE.BufferGeometry, count: number) {
  const g = wing.clone();
  g.setAttribute(
    "beat",
    new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2),
  );
  return g;
}

/** Sets a bird's body and wings from its pose: tilted and banked, the
 * wings' shoulders and tips at their own heights (see wingMaterial). */
function place(
  body: THREE.InstancedMesh,
  wing: THREE.InstancedMesh,
  i: number,
  p: Pose,
  size: number,
) {
  v.set(p.x, p.y, p.z);
  e.set(-p.pitch, p.heading, p.roll, "YXZ");
  q.setFromEuler(e);
  scale.setScalar(size);
  m4.compose(v, q, scale);
  body.setMatrixAt(i, m4);
  // Folded wings are narrow as well as down.
  scale.set(p.spread * size, size, size);
  m4.compose(v, q, scale);
  wing.setMatrixAt(i, m4);
  const attr = wing.geometry.attributes.beat as THREE.BufferAttribute;
  attr.setXY(i, p.beat, p.tip);
  attr.needsUpdate = true;
}
