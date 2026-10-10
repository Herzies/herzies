import { mulberry32 } from "@herzies/shared";
import { useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { ambient } from "./ambient";
import { chimneysOf } from "./Buildings";
import {
  cellAt,
  cellCenter,
  isSunk,
  MAP_SIZE,
  objectAt,
  objectJitter,
  type TownMap,
  terrainAt,
} from "./map";
import { useTownRuntime } from "./runtime";

/**
 * Little things that move: fireflies at night, smoke from chimneys,
 * butterflies over flowers by day, leaves now and then falling from the
 * trees, and dust kicked up at your feet. Each is one draw call: point
 * sprites (crisp squares, like the rest of the pixelated Town) or a small
 * instanced mesh, moved on the CPU — there are only ever a few hundred.
 */
export function Particles({ map }: { map: TownMap }) {
  return (
    <>
      <Fireflies map={map} />
      <Smoke map={map} />
      <Butterflies map={map} />
      <FallingLeaves map={map} />
      <Dust map={map} />
    </>
  );
}

// --- Point sprites ---------------------------------------------------------

/** A pool of square point sprites, each with its own size (world units),
 * colour and opacity, written on the CPU every frame. */
function usePoints(count: number, blending: THREE.Blending) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const points = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(count * 3), 3),
    );
    geometry.setAttribute(
      "size",
      new THREE.BufferAttribute(new Float32Array(count), 1),
    );
    geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(count * 3), 3),
    );
    geometry.setAttribute(
      "alpha",
      new THREE.BufferAttribute(new Float32Array(count), 1),
    );
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending,
      uniforms: { uPixels: { value: 1 } },
      vertexShader: /* glsl */ `
        uniform float uPixels;
        attribute float size;
        attribute float alpha;
        attribute vec3 color;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vAlpha = alpha;
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, size * uPixels / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          if (vAlpha <= 0.0) discard;
          gl_FragColor = vec4(vColor, vAlpha);
          #include <colorspace_fragment>
        }
      `,
    });
    return { geometry, material };
  }, [count, blending]);
  useLayoutEffect(
    () => () => {
      points.geometry.dispose();
      points.material.dispose();
    },
    [points],
  );
  // World size → pixels at distance 1, in the canvas's own (low-res) pixels.
  useFrame(() => {
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 55;
    points.material.uniforms.uPixels.value =
      gl.domElement.height / (2 * Math.tan((fov * Math.PI) / 360));
  });
  const a = points.geometry.attributes;
  return {
    ...points,
    set(
      i: number,
      x: number,
      y: number,
      z: number,
      size: number,
      alpha: number,
    ) {
      (a.position as THREE.BufferAttribute).setXYZ(i, x, y, z);
      (a.size as THREE.BufferAttribute).setX(i, size);
      (a.alpha as THREE.BufferAttribute).setX(i, alpha);
    },
    color(i: number, c: THREE.Color) {
      (a.color as THREE.BufferAttribute).setXYZ(i, c.r, c.g, c.b);
    },
    flush() {
      for (const name of ["position", "size", "alpha", "color"]) {
        (a[name] as THREE.BufferAttribute).needsUpdate = true;
      }
      points.geometry.computeBoundingSphere();
    },
  };
}

function cellsWhere(
  test: (col: number, row: number) => boolean,
): [number, number][] {
  const out: [number, number][] = [];
  for (let row = 0; row < MAP_SIZE; row++) {
    for (let col = 0; col < MAP_SIZE; col++) {
      if (test(col, row)) out.push([col, row]);
    }
  }
  return out;
}

// --- Fireflies ---------------------------------------------------------------

const FIREFLIES = 80;
const FIREFLY = new THREE.Color("#fff08a");

/** Warm sparks drifting low over tall grass, by the water and under the
 * trees — they come out at dusk, and blink. */
function Fireflies({ map }: { map: TownMap }) {
  const pts = usePoints(FIREFLIES, THREE.AdditiveBlending);
  const flies = useMemo(() => {
    const homes = cellsWhere((c, r) => {
      const o = objectAt(map, c, r);
      if (o === "v" || o === "T" || o === "*") return true;
      // Beside water.
      return (
        !isSunk(terrainAt(map, c, r)) &&
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dc, dr]) => isSunk(terrainAt(map, c + dc, r + dr)))
      );
    });
    const rand = mulberry32(31337);
    return Array.from({ length: homes.length > 0 ? FIREFLIES : 0 }, () => {
      const [x, z] = cellCenter(...homes[Math.floor(rand() * homes.length)]);
      return {
        x,
        z,
        y: 0.5 + rand() * 1.4,
        phase: rand() * 100,
        speed: 0.3 + rand() * 0.4,
        blink: 1.2 + rand() * 2,
      };
    });
  }, [map]);
  useLayoutEffect(() => {
    for (let i = 0; i < FIREFLIES; i++) pts.color(i, FIREFLY);
  }, [pts]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const night = THREE.MathUtils.smoothstep(ambient.uNight.value, 0.3, 0.8);
    flies.forEach((f, i) => {
      const p = f.phase + t * f.speed;
      const glow = (0.5 + 0.5 * Math.sin(t * f.blink + f.phase)) ** 3;
      pts.set(
        i,
        f.x + Math.sin(p) * 1.2 + Math.sin(p * 2.7) * 0.3,
        f.y + Math.sin(p * 1.3) * 0.4,
        f.z + Math.cos(p * 0.9) * 1.2,
        0.24,
        glow * night,
      );
    });
    pts.flush();
  });
  return (
    <points
      geometry={pts.geometry}
      material={pts.material}
      frustumCulled={false}
      visible={flies.length > 0}
    />
  );
}

// --- Chimney smoke -----------------------------------------------------------

const PUFFS = 10;
const SMOKE = new THREE.Color("#d9d6d0");

/** A slow column of puffs from every chimney, leaning downwind, widening
 * and fading as it rises. */
function Smoke({ map }: { map: TownMap }) {
  const chimneys = useMemo(() => chimneysOf(map), [map]);
  const count = Math.max(1, chimneys.length * PUFFS);
  const pts = usePoints(count, THREE.NormalBlending);
  useLayoutEffect(() => {
    for (let i = 0; i < count; i++) pts.color(i, SMOKE);
  }, [pts, count]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const wind = ambient.uWindDir.value;
    chimneys.forEach(([x, y, z], c) => {
      for (let j = 0; j < PUFFS; j++) {
        const age = (t * 0.18 + j / PUFFS + c * 0.37) % 1;
        const drift = age * age * 2.5;
        pts.set(
          c * PUFFS + j,
          x + wind.x * drift + Math.sin(t + j) * 0.08,
          y + age * 3.2,
          z + wind.y * drift,
          0.35 + age * 0.9,
          0.55 * (1 - age) * Math.min(1, age * 8),
        );
      }
    });
    pts.flush();
  });
  if (chimneys.length === 0) return null;
  return (
    <points
      geometry={pts.geometry}
      material={pts.material}
      frustumCulled={false}
    />
  );
}

// --- Footstep dust -------------------------------------------------------------

const DUST = 24;
const DUST_LIFE = 0.45;
/** Ground covered between puffs, in world units. */
const DUST_EVERY = 0.4;
/** How far either side of its path a foot comes down. */
const DUST_FOOT = 0.22;

/** Small, faint puffs at the player's feet while they run, the colour of
 * what they're running on — none on bridges or in water. Dropped where the
 * herzie is drawn (its interpolated body, not the physics step ahead of
 * it), every so far walked rather than every so often, so they stay
 * evenly spaced at its feet through a slow frame. Left foot, right foot:
 * one puff dead centre behind it read as something else entirely. */
function Dust({ map }: { map: TownMap }) {
  const rt = useTownRuntime();
  const pts = usePoints(DUST, THREE.NormalBlending);
  const pool = useRef(
    Array.from({ length: DUST }, () => ({
      x: 0,
      z: 0,
      born: -10,
      dx: 0,
      dz: 0,
    })),
  );
  const next = useRef(0);
  /** Where the last puff dropped, or null when not running. */
  const lastPuff = useRef<{ x: number; z: number } | null>(null);
  /** Which foot is next: 1 or −1. */
  const foot = useRef(1);
  const feet = useMemo(() => new THREE.Vector3(), []);
  const rand = useMemo(() => mulberry32(99), []);
  const gravel = useMemo(() => new THREE.Color("#a89c8c"), []);
  const grass = useMemo(() => new THREE.Color("#7a9a6a"), []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const body = rt.playerBody;
    if (body && rt.playerSpeed > 2.5) {
      body.getWorldPosition(feet);
      const last = lastPuff.current;
      if (!last) lastPuff.current = { x: feet.x, z: feet.z };
      else if (Math.hypot(feet.x - last.x, feet.z - last.z) >= DUST_EVERY) {
        // Off to the side of the way it's going, a foot at a time.
        const moved = Math.hypot(feet.x - last.x, feet.z - last.z);
        foot.current = -foot.current;
        const side = foot.current * DUST_FOOT;
        const fx = feet.x + (-(feet.z - last.z) / moved) * side;
        const fz = feet.z + ((feet.x - last.x) / moved) * side;
        lastPuff.current = { x: feet.x, z: feet.z };
        const [c, r] = cellAt(fx, fz);
        const ground = terrainAt(map, c, r);
        if (ground === "g" || ground === ".") {
          const i = next.current;
          next.current = (i + 1) % DUST;
          pool.current[i] = {
            x: fx + (rand() - 0.5) * 0.08,
            z: fz + (rand() - 0.5) * 0.08,
            born: t,
            dx: (rand() - 0.5) * 0.3,
            dz: (rand() - 0.5) * 0.3,
          };
          pts.color(i, ground === "g" ? gravel : grass);
        }
      }
    } else lastPuff.current = null;
    pool.current.forEach((p, i) => {
      const age = (t - p.born) / DUST_LIFE;
      if (age > 1) {
        pts.set(i, 0, -10, 0, 0, 0);
        return;
      }
      pts.set(
        i,
        p.x + p.dx * age,
        0.06 + age * 0.18,
        p.z + p.dz * age,
        0.1 + age * 0.12,
        0.35 * (1 - age),
      );
    });
    pts.flush();
  });
  return (
    <points
      geometry={pts.geometry}
      material={pts.material}
      frustumCulled={false}
    />
  );
}

// --- Butterflies ---------------------------------------------------------------

const MAX_BUTTERFLIES = 24;
const WING_COLORS = ["#f2d03b", "#f4f1ea", "#e86fa8", "#7fb0f0", "#f08a3a"];

/** A pair of wings: two triangles meeting at the body, along x. */
function wingGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        0, 0, -0.06, 0.16, 0, -0.1, 0.12, 0, 0.1, 0, 0, -0.06, -0.12, 0, 0.1,
        -0.16, 0, -0.1,
      ],
      3,
    ),
  );
  g.computeVertexNormals();
  return g;
}
const wings = wingGeometry();
const wingMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

/** A few butterflies over the flower patches by day, fluttering about. */
function Butterflies({ map }: { map: TownMap }) {
  const flies = useMemo(() => {
    const beds = cellsWhere((c, r) => objectAt(map, c, r) === "*");
    const rand = mulberry32(2024);
    const n = Math.min(MAX_BUTTERFLIES, Math.ceil(beds.length / 2));
    return Array.from({ length: n }, () => {
      const [x, z] = cellCenter(...beds[Math.floor(rand() * beds.length)]);
      return {
        x,
        z,
        phase: rand() * 100,
        flap: 12 + rand() * 6,
        color: WING_COLORS[Math.floor(rand() * WING_COLORS.length)],
      };
    });
  }, [map]);
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const c = new THREE.Color();
    for (const [i, f] of flies.entries()) mesh.setColorAt(i, c.set(f.color));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [flies]);
  const m = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const e = useMemo(() => new THREE.Euler(), []);
  const pos = useMemo(() => new THREE.Vector3(), []);
  const scale = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ clock }) => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = clock.elapsedTime;
    // Gone by night: tucked away (scaled to nothing).
    const day = 1 - THREE.MathUtils.smoothstep(ambient.uNight.value, 0.3, 0.6);
    flies.forEach((f, i) => {
      const p = f.phase + t * 0.6;
      pos.set(
        f.x + Math.sin(p) * 0.8 + Math.sin(p * 2.3) * 0.25,
        0.55 + Math.sin(p * 1.7) * 0.25 + Math.abs(Math.sin(t * f.flap)) * 0.05,
        f.z + Math.cos(p * 0.8) * 0.8,
      );
      // Facing where it's heading (the derivative of the path, roughly).
      const heading = Math.atan2(Math.cos(p), -Math.sin(p * 0.8));
      const flap = Math.sin(t * f.flap + f.phase);
      e.set(0, heading, 0);
      q.setFromEuler(e);
      scale.set(day * (0.25 + 0.75 * Math.abs(flap)), day, day);
      m.compose(pos, q, scale);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  if (flies.length === 0) return null;
  return (
    <instancedMesh
      key={flies.length}
      ref={ref}
      args={[wings, wingMaterial, flies.length]}
      frustumCulled={false}
    />
  );
}

// --- Falling leaves --------------------------------------------------------------

const LEAVES = 14;
const LEAF_FALL = 7;
const leafGeometry = new THREE.PlaneGeometry(0.16, 0.1);
const leafMaterial = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
const LEAF_COLORS = ["#4f8a3e", "#6a9a3a", "#c8a03a", "#b8702e"];

/** Now and then a leaf lets go of a tree and tumbles down on the wind. */
function FallingLeaves({ map }: { map: TownMap }) {
  const trees = useMemo(
    () =>
      cellsWhere((c, r) => objectAt(map, c, r) === "T").map(([c, r]) =>
        objectJitter(c, r),
      ),
    [map],
  );
  const rand = useMemo(() => mulberry32(5150), []);
  const leaves = useRef(
    // Each starts "already landed", so the first frame sends it up a tree
    // (rather than drifting out from the middle of town).
    Array.from({ length: LEAVES }, () => ({
      x: 0,
      y: 0,
      z: 0,
      born: Number.NEGATIVE_INFINITY,
      spin: 0,
    })),
  );
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const c = new THREE.Color();
    for (let i = 0; i < LEAVES; i++) {
      mesh.setColorAt(i, c.set(LEAF_COLORS[i % LEAF_COLORS.length]));
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, []);
  const m = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const e = useMemo(() => new THREE.Euler(), []);
  const pos = useMemo(() => new THREE.Vector3(), []);
  const one = useMemo(() => new THREE.Vector3(1, 1, 1), []);
  const zero = useMemo(() => new THREE.Vector3(0, 0, 0), []);

  useFrame(({ clock }) => {
    const mesh = ref.current;
    if (!mesh || trees.length === 0) return;
    const t = clock.elapsedTime;
    const wind = ambient.uWindDir.value;
    leaves.current.forEach((l, i) => {
      let age = (t - l.born) / LEAF_FALL;
      if (age > 1) {
        // Off another tree, from somewhere in its canopy.
        const tree = trees[Math.floor(rand() * trees.length)];
        const a = rand() * Math.PI * 2;
        l.x = tree.x + Math.cos(a) * 1.2 * tree.scale;
        l.z = tree.z + Math.sin(a) * 1.2 * tree.scale;
        l.y = (4 + rand() * 3) * tree.scale;
        // Let go a while from now, so they don't all fall at once.
        l.born = t + rand() * LEAF_FALL;
        l.spin = rand() * 10;
        age = (t - l.born) / LEAF_FALL;
      }
      const k = Math.max(0, age);
      const sway = Math.sin(t * 2.2 + l.spin) * 0.5;
      pos.set(
        l.x + wind.x * k * 3 + sway * 0.4,
        Math.max(0.03, l.y * (1 - k)),
        l.z + wind.y * k * 3 + Math.cos(t * 1.7 + l.spin) * 0.3,
      );
      e.set(sway + t * 1.5, l.spin + t, sway);
      q.setFromEuler(e);
      // Out of sight until it lets go of its tree.
      m.compose(pos, q, age < 0 ? zero : one);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  if (trees.length === 0) return null;
  return (
    <instancedMesh
      ref={ref}
      args={[leafGeometry, leafMaterial, LEAVES]}
      frustumCulled={false}
    />
  );
}
