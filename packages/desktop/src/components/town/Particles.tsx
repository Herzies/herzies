import { mulberry32 } from "@herzies/shared";
import { useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { ambient, gustAt, seasonNow } from "./ambient";
import { chimneysOf } from "./Buildings";
import { FOOTPRINT_LIFE, footprints, Trail } from "./footprints";
import {
  cellCenter,
  groundY,
  isSunk,
  objectAt,
  objectJitter,
  type TownMap,
  terrainAt,
} from "./map";
import { useTownRuntime } from "./runtime";

/**
 * Little things that move: fireflies at night, smoke from chimneys,
 * butterflies over flowers by day, leaves falling from the trees (or
 * blossom, in spring), and snow in winter.
 * How many of each comes and goes with the seasons (see Seasons.ts). Each is one draw call: point
 * sprites (crisp squares, like the rest of the pixelated Town) or a small
 * instanced mesh, moved on the CPU — there are only ever a few hundred.
 */
export function Particles({ map }: { map: TownMap }) {
  return (
    <>
      <Fireflies map={map} />
      <Motes map={map} />
      <Smoke map={map} />
      <Butterflies map={map} />
      <FallingLeaves map={map} />
      <Snowfall />
      <SnowPrints map={map} />
    </>
  );
}

// --- Point sprites ---------------------------------------------------------

/** A pool of square point sprites, each with its own size (world units),
 * colour and opacity, written on the CPU every frame. `round`: each one
 * clipped to a circle (still hard-edged, in the Town's pixels). */
function usePoints(count: number, blending: THREE.Blending, round = false) {
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
      defines: round ? { ROUND: "" } : {},
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
          #ifdef ROUND
          if (length(gl_PointCoord - 0.5) > 0.5) discard;
          #endif
          gl_FragColor = vec4(vColor, vAlpha);
          #include <colorspace_fragment>
        }
      `,
    });
    return { geometry, material };
  }, [count, blending, round]);
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
  map: TownMap,
  test: (col: number, row: number) => boolean,
): [number, number][] {
  const out: [number, number][] = [];
  for (let row = 0; row < map.size; row++) {
    for (let col = 0; col < map.size; col++) {
      if (test(col, row)) out.push([col, row]);
    }
  }
  return out;
}

// --- Fireflies ---------------------------------------------------------------

const FIREFLIES = 30;
const FIREFLY = new THREE.Color("#fff08a");

/** Warm sparks drifting low over tall grass, by the water and under the
 * trees — they come out at dusk, and blink. */
function Fireflies({ map }: { map: TownMap }) {
  const pts = usePoints(FIREFLIES, THREE.AdditiveBlending);
  const flies = useMemo(() => {
    const homes = cellsWhere(map, (c, r) => {
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
      const [x, z] = cellCenter(
        map,
        ...homes[Math.floor(rand() * homes.length)],
      );
      return {
        x,
        z,
        y: groundY(map, x, z) + 0.5 + rand() * 1.4,
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
        0.13,
        glow * night * seasonNow.look.fireflies * (1 - ambient.uRain.value),
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

// --- Motes -------------------------------------------------------------------

const MOTES = 40;
const MOTE = new THREE.Color("#fff6d8");
/** How far from the player motes are kept: they're too faint to see
 * further off, so the few there are stay close. */
const MOTE_REACH = 9;
const MOTE_HEIGHT = 3;

/** Dust and pollen hanging in the daylight round the player: faint
 * specks drifting on the air, catching the sun now and then. Kept in a
 * box round the player, wrapped like the snow, so they're wherever you
 * look. Gone at night (the fireflies take over) and in the rain. */
function Motes({ map }: { map: TownMap }) {
  const pts = usePoints(MOTES, THREE.NormalBlending);
  const motes = useMemo(() => {
    const rand = mulberry32(8086);
    return Array.from({ length: MOTES }, () => ({
      x: rand() * MOTE_REACH * 2,
      y: rand() * MOTE_HEIGHT,
      z: rand() * MOTE_REACH * 2,
      phase: rand() * 100,
      speed: 0.6 + rand() * 0.8,
      size: 0.02 + rand() * 0.02,
    }));
  }, []);
  useLayoutEffect(() => {
    for (let i = 0; i < MOTES; i++) pts.color(i, MOTE);
  }, [pts]);
  const shown = useRef(false);

  useFrame(({ clock }) => {
    // By day only, and not in winter's bare air.
    const day =
      (1 - THREE.MathUtils.smoothstep(ambient.uNight.value, 0.2, 0.5)) *
      (1 - ambient.uSnow.value) *
      (1 - ambient.uRain.value);
    if (day <= 0 && !shown.current) return;
    shown.current = day > 0;
    const t = clock.elapsedTime;
    const wind = ambient.uWindDir.value;
    const { x: px, z: pz } = ambient.uPlayer.value;
    const wrap = (v: number, n: number) => ((v % n) + n) % n;
    const span = MOTE_REACH * 2;
    const gust = gustAt(px, pz, t);
    motes.forEach((m, i) => {
      const drift = t * 0.25 * m.speed * (0.5 + gust);
      const x = px - MOTE_REACH + wrap(m.x + wind.x * drift - px, span);
      const z = pz - MOTE_REACH + wrap(m.z + wind.y * drift - pz, span);
      const y =
        groundY(map, x, z) +
        0.3 +
        wrap(m.y + Math.sin(t * 0.4 * m.speed + m.phase) * 0.6, MOTE_HEIGHT);
      // Each catches the light now and then: a slow blink, mostly dim.
      const glint = Math.max(0, Math.sin(t * 0.9 * m.speed + m.phase)) ** 4;
      pts.set(
        i,
        x + Math.sin(t * 0.7 + m.phase) * 0.3,
        y,
        z + Math.cos(t * 0.5 + m.phase) * 0.3,
        m.size,
        day * (0.08 + 0.3 * glint),
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

// --- Chimney smoke -----------------------------------------------------------

const PUFFS = 10;
const SMOKE = new THREE.Color("#d9d6d0");

/** A slow column of puffs from every chimney, leaning downwind, widening
 * and fading as it rises. */
function Smoke({ map }: { map: TownMap }) {
  const chimneys = useMemo(() => chimneysOf(map), [map]);
  const count = Math.max(1, chimneys.length * PUFFS);
  // Round puffs, not boxes.
  const pts = usePoints(count, THREE.NormalBlending, true);
  useLayoutEffect(() => {
    for (let i = 0; i < count; i++) pts.color(i, SMOKE);
  }, [pts, count]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const wind = ambient.uWindDir.value;
    chimneys.forEach(([x, y, z], c) => {
      // The same gusts as the trees (see swayInWind): the column leans
      // further as one rolls past the chimney.
      const gust = 0.6 + 0.8 * gustAt(x, z, t);
      for (let j = 0; j < PUFFS; j++) {
        const age = (t * 0.18 + j / PUFFS + c * 0.37) % 1;
        const drift = age * age * 2.5 * gust;
        pts.set(
          c * PUFFS + j,
          x + wind.x * drift + Math.sin(t + j) * 0.08,
          y + age * 3.2,
          z + wind.y * drift,
          0.35 + age * 0.9,
          0.55 * (1 - age) * Math.min(1, age * 8) * seasonNow.look.smoke,
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
    const beds = cellsWhere(map, (c, r) => objectAt(map, c, r) === "*");
    const rand = mulberry32(2024);
    const n = Math.min(MAX_BUTTERFLIES, Math.ceil(beds.length / 2));
    return Array.from({ length: n }, () => {
      const [x, z] = cellCenter(map, ...beds[Math.floor(rand() * beds.length)]);
      return {
        x,
        y: groundY(map, x, z),
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
    const day =
      (1 - THREE.MathUtils.smoothstep(ambient.uNight.value, 0.3, 0.6)) *
      seasonNow.look.butterflies *
      (1 - THREE.MathUtils.smoothstep(ambient.uRain.value, 0.05, 0.4));
    flies.forEach((f, i) => {
      const p = f.phase + t * 0.6;
      pos.set(
        f.x + Math.sin(p) * 0.8 + Math.sin(p * 2.3) * 0.25,
        f.y +
          0.55 +
          Math.sin(p * 1.7) * 0.25 +
          Math.abs(Math.sin(t * f.flap)) * 0.05,
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

/** As many as fall at the height of fall; a summer's trickle is a
 * quarter of them (see Seasons.ts). */
const LEAVES = 56;
const LEAF_FALL = 7;
const leafGeometry = new THREE.PlaneGeometry(0.16, 0.1);
const leafMaterial = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
const LEAF_COLORS = ["#4f8a3e", "#6a9a3a", "#c8a03a", "#b8702e"];
const FALL_COLORS = ["#c8432a", "#e0782a", "#d9a032", "#a8502a", "#e8b84a"];
const PETAL_COLORS = ["#f4b8c8", "#f8e8ec", "#eea0b8"];

/** What a leaf letting go now is: blossom in spring, red and gold in
 * fall, mostly green in summer. */
function leafColor(rand: () => number): string {
  const { petals, leaves, fall } = seasonNow.look;
  const from =
    petals > leaves ? PETAL_COLORS : rand() < fall ? FALL_COLORS : LEAF_COLORS;
  return from[Math.floor(rand() * from.length)];
}

/** Leaves let go of the trees and tumble down on the wind: now and then
 * in summer, in drifts in fall, none in winter — and in spring, petals. */
function FallingLeaves({ map }: { map: TownMap }) {
  const trees = useMemo(
    () =>
      cellsWhere(map, (c, r) => objectAt(map, c, r) === "T").map(([c, r]) => {
        const at = objectJitter(map, c, r);
        return { ...at, ground: groundY(map, at.x, at.z) };
      }),
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
      ground: 0,
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
  const color = useMemo(() => new THREE.Color(), []);
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
    const { leaves: many, petals } = seasonNow.look;
    const falling = Math.round(LEAVES * Math.max(many, petals));
    let recolored = false;
    leaves.current.forEach((l, i) => {
      let age = (t - l.born) / LEAF_FALL;
      // Out of season: lands, and stays down (out of sight).
      if (age > 1 && i >= falling) {
        m.compose(pos, q, zero);
        mesh.setMatrixAt(i, m);
        return;
      }
      if (age > 1) {
        mesh.setColorAt(i, color.set(leafColor(rand)));
        recolored = true;
        // Off another tree, from somewhere in its canopy.
        const tree = trees[Math.floor(rand() * trees.length)];
        const a = rand() * Math.PI * 2;
        l.x = tree.x + Math.cos(a) * 1.2 * tree.scale;
        l.z = tree.z + Math.sin(a) * 1.2 * tree.scale;
        l.y = (4 + rand() * 3) * tree.scale;
        l.ground = tree.ground;
        // Let go a while from now, so they don't all fall at once.
        l.born = t + rand() * LEAF_FALL;
        l.spin = rand() * 10;
        age = (t - l.born) / LEAF_FALL;
      }
      const k = Math.max(0, age);
      const sway = Math.sin(t * 2.2 + l.spin) * 0.5;
      pos.set(
        l.x + wind.x * k * 3 + sway * 0.4,
        l.ground + Math.max(0.03, l.y * (1 - k)),
        l.z + wind.y * k * 3 + Math.cos(t * 1.7 + l.spin) * 0.3,
      );
      e.set(sway + t * 1.5, l.spin + t, sway);
      q.setFromEuler(e);
      // Out of sight until it lets go of its tree.
      m.compose(pos, q, age < 0 ? zero : one);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (recolored && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
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

// --- Snow ----------------------------------------------------------------------

const FLAKES = 500;
const FLAKE = new THREE.Color("#f2f6ff");
/** The box of snow kept round the player, and how fast it falls. */
const SNOW_REACH = 16;
const SNOW_HEIGHT = 12;
const SNOW_FALL = 1.1;

/** Snow falling in winter (see Seasons.ts): a box of flakes round the
 * player, each drifting down on the wind and wobbling, wrapped round
 * the box so it never runs out. */
function Snowfall() {
  const pts = usePoints(FLAKES, THREE.NormalBlending);
  const flakes = useMemo(() => {
    const rand = mulberry32(1225);
    return Array.from({ length: FLAKES }, () => ({
      x: rand() * SNOW_REACH * 2,
      y: rand() * SNOW_HEIGHT,
      z: rand() * SNOW_REACH * 2,
      speed: 0.7 + rand() * 0.6,
      phase: rand() * 100,
      size: 0.03 + rand() * 0.035,
    }));
  }, []);
  useLayoutEffect(() => {
    for (let i = 0; i < FLAKES; i++) pts.color(i, FLAKE);
  }, [pts]);
  const shown = useRef(false);

  useFrame(({ clock }) => {
    const heavy = seasonNow.look.snowfall;
    const falling = Math.round(FLAKES * heavy);
    if (falling === 0 && !shown.current) return;
    shown.current = falling > 0;
    const t = clock.elapsedTime;
    const wind = ambient.uWindDir.value;
    const { x: px, y: py, z: pz } = ambient.uPlayer.value;
    const wrap = (v: number, n: number) => ((v % n) + n) % n;
    const span = SNOW_REACH * 2;
    flakes.forEach((f, i) => {
      const down = t * SNOW_FALL * f.speed;
      const wobble = Math.sin(t * 1.3 + f.phase) * 0.4;
      pts.set(
        i,
        px - SNOW_REACH + wrap(f.x + wind.x * down * 0.6 + wobble - px, span),
        py - 2 + wrap(f.y - down, SNOW_HEIGHT),
        pz - SNOW_REACH + wrap(f.z + wind.y * down * 0.6 - pz, span),
        f.size,
        i < falling ? 0.9 : 0,
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

// --- Prints in the snow ----------------------------------------------------------

const printGeometry = (() => {
  const g = new THREE.CircleGeometry(0.14, 7).rotateX(-Math.PI / 2);
  // Longer than wide, along the way it points.
  g.scale(1, 1, 1.45);
  return g;
})();
/** Pressed-in snow: its own shadow, as bright as the scene is lit (so
 * prints don't glow at night), fading out over the second half of their
 * life. */
const printMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  uniforms: { uTime: ambient.uTime, uLight: ambient.uLight },
  vertexShader: /* glsl */ `
    attribute float born;
    attribute float depth;
    uniform float uTime;
    varying float vAlpha;
    void main() {
      float age = uTime - born;
      vAlpha = depth * 0.8 * ( 1.0 - smoothstep( ${(FOOTPRINT_LIFE * 0.4).toFixed(2)}, ${FOOTPRINT_LIFE.toFixed(2)}, age ) ) * step( 0.0, age );
      gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uLight;
    varying float vAlpha;
    void main() {
      if ( vAlpha <= 0.0 ) discard;
      gl_FragColor = vec4( vec3( 0.3, 0.35, 0.48 ) * uLight, vAlpha );
      #include <colorspace_fragment>
    }
  `,
});

/**
 * Prints in the snow (see footprints.ts): the player's own trail stamped
 * here, every herzie's prints (theirs stamped by RemotePlayers) drawn as
 * one instanced mesh, placed again only when a print is added.
 */
function SnowPrints({ map }: { map: TownMap }) {
  const rt = useTownRuntime();
  const trail = useMemo(() => new Trail(0), []);
  const ref = useRef<THREE.InstancedMesh>(null);
  const shown = useRef(-1);
  const feet = useMemo(() => new THREE.Vector3(), []);
  const attrs = useMemo(
    () => ({
      born: new THREE.InstancedBufferAttribute(
        new Float32Array(footprints.capacity).fill(-1e6),
        1,
      ),
      depth: new THREE.InstancedBufferAttribute(
        new Float32Array(footprints.capacity),
        1,
      ),
    }),
    [],
  );
  const geometry = useMemo(() => {
    const g = printGeometry.clone();
    g.setAttribute("born", attrs.born);
    g.setAttribute("depth", attrs.depth);
    return g;
  }, [attrs]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  const m = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const pos = useMemo(() => new THREE.Vector3(), []);
  const scale = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const t = ambient.uTime.value;
    const body = rt.playerBody;
    if (body) {
      body.getWorldPosition(feet);
      trail.spread = rt.playerFootSpread;
      trail.step(
        map,
        footprints,
        feet.x,
        groundY(map, feet.x, feet.z),
        feet.z,
        seasonNow.look.snow,
        t,
      );
    }
    const mesh = ref.current;
    if (!mesh || shown.current === footprints.version) return;
    shown.current = footprints.version;
    footprints.prints.forEach((p, i) => {
      q.setFromAxisAngle(up, p.yaw);
      m.compose(pos.set(p.x, p.y + 0.02, p.z), q, scale.setScalar(p.size));
      mesh.setMatrixAt(i, m);
      attrs.born.setX(i, p.born);
      attrs.depth.setX(i, p.depth);
    });
    mesh.count = footprints.prints.length;
    mesh.instanceMatrix.needsUpdate = true;
    attrs.born.needsUpdate = true;
    attrs.depth.needsUpdate = true;
  });
  return (
    <instancedMesh
      ref={ref}
      args={[geometry, printMaterial, footprints.capacity]}
      count={0}
      frustumCulled={false}
    />
  );
}
