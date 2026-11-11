import { mulberry32 } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { ambient, inSeason } from "./ambient";

/** The sky, top to bottom: the fog fades everything far off into the
 * horizon colour, so distant islands melt into it. */
export const SKY = {
  top: "#0d1630",
  horizon: "#33507a",
  bottom: "#141f3a",
};

/** The sky dome's colours, top to bottom, and where the sun and moon are,
 * as live uniforms (see DayLight). */
export const skyUniforms = {
  uTop: { value: new THREE.Color(SKY.top) },
  uHorizon: { value: new THREE.Color(SKY.horizon) },
  uBottom: { value: new THREE.Color(SKY.bottom) },
  uSunDir: { value: new THREE.Vector3(0, -1, 0) },
  uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color("#fff4e0") },
  /** How dark it is (0 by day, 1 at night): the stars come out with it. */
  uNight: { value: 0 },
  /** How strong the northern lights are tonight, 0–1 (see DayLight: a
   * winter night in three). */
  uAurora: { value: 0 },
  /** A shooting star: where it started (xyz, unit) and how far along its
   * fall it is (w, 0–1; past 1 there's none). */
  uShoot: { value: new THREE.Vector4(0, 1, 0, 2) },
  /** Where it's falling to (unit). */
  uShootTo: { value: new THREE.Vector3(0, 1, 0) },
  /** How much of the sky the clouds hide, 0–1: the stars and the aurora
   * are behind them (see weather). */
  uOvercast: { value: 0 },
};

/** How often a star falls: one every this many seconds, give or take. */
const SHOOTING_EVERY = 90;
const SHOOTING_SPREAD = 60;
/** How long a fall lasts (s). */
const SHOOTING_LIFE = 0.9;

const GRASS = new THREE.Color("#2f5233");
/** Index in the island profile of the rim's top as the side sees it (the
 * next point is the same spot, as the top sees it). */
const RIM_TOP = 9;
const DIRT = new THREE.Color("#5a4030");
const ROCK = new THREE.Color("#8c7d6c");
const DEEP_ROCK = new THREE.Color("#4e4858");

/** A wobble around the island that wraps seamlessly: whole-number
 * frequencies of the angle, so the lathe's seam lines up. */
function wobble(rand: () => number) {
  const waves = Array.from({ length: 4 }, (_, i) => ({
    k: 2 + i * 2 + Math.floor(rand() * 2),
    phase: rand() * Math.PI * 2,
    amp: 0.08 + rand() * 0.1,
  }));
  return (angle: number, depth: number) =>
    waves.reduce(
      (sum, w) => sum + w.amp * Math.sin(w.k * angle + w.phase + depth * 0.35),
      0,
    );
}

/**
 * A floating island: a flat grass top (y = 0) `radius` across, a dirt rim,
 * and a rocky underside tapering to a point `depth` below — lumpy and
 * flat-shaded, coloured by height. Seeded, so the same seed is the same
 * island.
 */
export function islandGeometry(
  radius: number,
  depth: number,
  seed: number,
  {
    top = true,
    segments = 28,
  }: {
    /** Leave the flat top off (something else draws the ground). */
    top?: boolean;
    segments?: number;
  } = {},
): THREE.BufferGeometry {
  const rand = mulberry32(seed);
  // From the tip up to the rim, then in across the top. Rim points are
  // doubled, so the grass top and the side shade as separate faces.
  const profile = [
    [0, -depth],
    [0.08, -depth * 0.9],
    [0.18, -depth * 0.76],
    [0.3, -depth * 0.6],
    [0.44, -depth * 0.45],
    [0.6, -depth * 0.3],
    [0.75, -depth * 0.18],
    [0.9, -Math.min(depth * 0.08, 2.4)],
    [1, -0.8],
    [1, 0],
    ...(top
      ? [
          [1, 0],
          [0.5, 0],
          [0, 0],
        ]
      : []),
  ].map(([x, y]) => new THREE.Vector2(x * radius, y));
  const geometry = new THREE.LatheGeometry(profile, segments);

  // Make the rock lumpy: push each underside vertex in or out with the
  // wobble, more the deeper it is. The top stays flat to walk on. Lathe
  // vertices run profile point by profile point, one ring per segment.
  const wob = wobble(rand);
  const pos = geometry.attributes.position;
  const colors: number[] = [];
  const color = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const j = i % profile.length;
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const below = -y / depth; // 0 at the top, 1 at the tip
    if (j < RIM_TOP) {
      const s = 1 + wob(Math.atan2(z, x), y) * (0.4 + below);
      pos.setXYZ(i, x * s, y * (1 + wob(Math.atan2(x, z), 0) * 0.3), z * s);
    }
    if (j > RIM_TOP) color.copy(GRASS);
    else if (j >= RIM_TOP - 1) color.copy(DIRT);
    else color.lerpColors(ROCK, DEEP_ROCK, Math.min(1, below * 1.4));
    colors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

const islandMaterial = inSeason(
  new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
  }),
  "grass",
);

/** Our island, the one the town stands on: just its rock — the map's
 * ground (see Ground) is its top. Finely segmented, so the rim meets the
 * ground's round edge. */
export function HomeIsland({ radius }: { radius: number }) {
  const geometry = useMemo(
    () =>
      islandGeometry(radius, radius * 0.75, 20261008, {
        top: false,
        segments: 96,
      }),
    [radius],
  );
  return <mesh geometry={geometry} material={islandMaterial} />;
}

/** A gradient dome around everything: the sky, above and below. */
export function Sky() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        // Shared, so the day cycle repaints the sky (see DayLight).
        uniforms: { ...skyUniforms, uTime: ambient.uTime },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uTop;
          uniform vec3 uHorizon;
          uniform vec3 uBottom;
          uniform vec3 uSunDir;
          uniform vec3 uMoonDir;
          uniform vec3 uSunColor;
          uniform float uTime;
          uniform float uNight;
          uniform float uAurora;
          uniform vec4 uShoot;
          uniform vec3 uShootTo;
          uniform float uOvercast;
          varying vec3 vDir;
          // Angular radii, as cosines: the sun about 2.6 degrees, the moon 1.8.
          const float SUN_DISC = 0.99897;
          const float MOON_DISC = 0.99951;
          // The star field's cells per unit of direction: one star to a
          // cell, in some of them.
          const float STAR_CELLS = 34.0;
          float hash(vec3 p) {
            return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          }
          vec3 hash3(vec3 p) {
            return vec3(hash(p), hash(p + 17.3), hash(p + 41.7));
          }
          // The stars: the sky cut into cells, a star in two of every
          // five, each its own brightness and twinkle, a few of them
          // faintly coloured. Crisp points at the Town's pixels.
          vec3 stars(vec3 dir) {
            vec3 cell = floor(dir * STAR_CELLS);
            float h = hash(cell);
            if (h < 0.72) return vec3(0.0);
            vec3 at = normalize((cell + 0.5 + (hash3(cell + 3.1) - 0.5) * 0.7) / STAR_CELLS);
            float d = 1.0 - dot(dir, at);
            // The angular radius, as 1 - cos: a tenth of a degree, the
            // brightest a fifth — a pixel or two at the Town's resolution.
            float r = 0.0000015 + (h - 0.72) * 0.000016;
            float disc = 1.0 - smoothstep(r * 0.5, r, d);
            float b = hash(cell + 7.7);
            float bright = 0.2 + 0.8 * b * b;
            float twinkle = 0.75 + 0.25 * sin(uTime * (1.5 + hash(cell + 9.1) * 3.5) + hash(cell + 2.2) * 50.0);
            float tint = hash(cell + 5.5);
            vec3 colour = tint < 0.15 ? vec3(1.0, 0.85, 0.7) : tint < 0.3 ? vec3(0.8, 0.88, 1.0) : vec3(1.0);
            return colour * disc * bright * twinkle;
          }
          // Value noise over a plane, for the aurora's curtains.
          float vnoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            float a = hash(vec3(i, 0.0));
            float b = hash(vec3(i + vec2(1.0, 0.0), 0.0));
            float c = hash(vec3(i + vec2(0.0, 1.0), 0.0));
            float d = hash(vec3(i + vec2(1.0, 1.0), 0.0));
            return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
          }
          // Northern lights: a band low over the north (-z), curtains of
          // green with a violet fringe above, rippling slowly sideways.
          vec3 aurora(vec3 dir) {
            if (uAurora <= 0.0 || dir.z > 0.2) return vec3(0.0);
            float band = smoothstep(0.08, 0.22, dir.y) * (1.0 - smoothstep(0.3, 0.62, dir.y));
            if (band <= 0.0) return vec3(0.0);
            float along = atan(dir.x, -dir.z) * 3.0;
            float t = uTime * 0.05;
            float curtain = vnoise(vec2(along * 1.6 + t, dir.y * 2.0 - t * 0.6))
              * 0.6 + 0.4 * vnoise(vec2(along * 4.5 - t * 1.7, dir.y * 6.0));
            curtain = smoothstep(0.42, 0.78, curtain);
            float up = (dir.y - 0.08) / 0.5;
            vec3 colour = mix(vec3(0.15, 0.9, 0.45), vec3(0.6, 0.3, 0.9), smoothstep(0.35, 0.9, up));
            return colour * curtain * band * uAurora * 0.55;
          }
          // A shooting star: a short bright streak with a fading tail,
          // along the chord from where it started towards uShootTo.
          vec3 shooting(vec3 dir) {
            float k = uShoot.w;
            if (k < 0.0 || k > 1.0) return vec3(0.0);
            vec3 head = normalize(mix(uShoot.xyz, uShootTo, k));
            vec3 tail = normalize(mix(uShoot.xyz, uShootTo, max(0.0, k - 0.18)));
            vec3 seg = head - tail;
            float len2 = max(dot(seg, seg), 1e-6);
            float along = clamp(dot(dir - tail, seg) / len2, 0.0, 1.0);
            vec3 near = tail + seg * along;
            float d = length(dir - near);
            float streak = 1.0 - smoothstep(0.0, 0.0045, d);
            // Brightest at the head, gone at the tail; flaring in and out.
            float life = sin(k * 3.14159);
            return vec3(1.0, 0.97, 0.9) * streak * along * along * life * 1.6;
          }
          void main() {
            vec3 dir = normalize(vDir);
            float h = dir.y;
            vec3 c = h > 0.0
              ? mix(uHorizon, uTop, smoothstep(0.0, 0.6, h))
              : mix(uHorizon, uBottom, smoothstep(0.0, 0.5, -h));
            // Each sinks into the haze at the horizon: dimmer the lower the
            // pixel, and fading out as it sets rather than cut off by it.
            float haze = smoothstep(-0.03, 0.14, h);
            // The stars come out as the sky darkens, thinning at the
            // horizon, and behind the clouds there are none.
            float dark = smoothstep(0.5, 0.95, uNight) * haze * (1.0 - uOvercast);
            if (dark > 0.0) {
              c += (stars(dir) + shooting(dir)) * dark;
              c += aurora(dir) * dark;
            }
            float toSun = dot(dir, uSunDir);
            float toMoon = dot(dir, uMoonDir);
            float sunUp = smoothstep(-0.1, 0.12, uSunDir.y) * haze;
            // A wide warm glow, then a hard-edged disc that stays crisp
            // in the Town's chunky pixels — warmer and hazier as it sets.
            vec3 sun = mix(uSunColor, vec3(1.0, 0.98, 0.9), 0.55);
            sun = mix(mix(uHorizon, uSunColor, 0.7), sun, haze);
            c += uSunColor * pow(max(toSun, 0.0), 48.0) * 0.35 * sunUp;
            c = mix(c, sun, step(SUN_DISC, toSun) * sunUp);
            float moonUp = smoothstep(-0.06, 0.06, uMoonDir.y) * haze * (1.0 - uOvercast * 0.85);
            c += vec3(0.55, 0.62, 0.8) * pow(max(toMoon, 0.0), 90.0) * 0.4 * moonUp;
            c = mix(c, vec3(0.95, 0.97, 1.0), step(MOON_DISC, toMoon) * moonUp);
            gl_FragColor = vec4(c, 1.0);
            #include <colorspace_fragment>
          }
        `,
      }),
    [],
  );
  const sky = useRef<THREE.Mesh>(null);
  // The next shooting star: when it falls, from where to where. Each
  // player sees their own; they're too brief to share.
  const shoot = useRef({ at: SHOOTING_EVERY * 0.3, started: Number.NaN });
  // Centred on the camera, so it is always at the horizon's distance.
  useFrame(({ camera, clock }) => {
    sky.current?.position.copy(camera.position);
    const t = clock.elapsedTime;
    const s = shoot.current;
    const u = skyUniforms;
    if (Number.isNaN(s.started)) {
      if (t < s.at) return;
      // Only at night: by day, wait for the next one instead.
      if (u.uNight.value < 0.6) {
        s.at = t + 20 + Math.random() * 20;
        return;
      }
      // High up, falling a little way sideways and down.
      const a = Math.random() * Math.PI * 2;
      const y = 0.35 + Math.random() * 0.4;
      const r = Math.sqrt(1 - y * y);
      const from = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
      const to = from
        .clone()
        .add(
          new THREE.Vector3(
            (Math.random() - 0.5) * 0.5,
            -(0.12 + Math.random() * 0.15),
            (Math.random() - 0.5) * 0.5,
          ),
        )
        .normalize();
      u.uShoot.value.set(from.x, from.y, from.z, 0);
      u.uShootTo.value.copy(to);
      s.started = t;
    }
    const k = (t - s.started) / SHOOTING_LIFE;
    u.uShoot.value.w = k;
    if (k > 1) {
      s.started = Number.NaN;
      s.at = t + SHOOTING_EVERY + (Math.random() - 0.5) * SHOOTING_SPREAD;
      u.uShoot.value.w = 2;
    }
  });
  return (
    <mesh ref={sky} material={material} renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[300, 32, 16]} />
    </mesh>
  );
}

type Distant = {
  x: number;
  y: number;
  z: number;
  radius: number;
  seed: number;
  trees: { x: number; z: number; s: number }[];
  bob: number;
  spin: number;
};

/** Islands drifting in the distance, some above the horizon and some
 * below. The same for everyone. */
function scatterIslands(): Distant[] {
  const rand = mulberry32(8102026);
  const count = 9;
  return Array.from({ length: count }, (_, i) => {
    // Spread round the compass, alternating high and low.
    const angle = ((i + rand() * 0.6) / count) * Math.PI * 2;
    const dist = 110 + rand() * 90;
    const high = i % 2 === 0;
    // Low ones sit shallow enough to show past our island's edge.
    const y = high ? 15 + rand() * 35 : -(8 + rand() * 22);
    const radius = 5 + rand() * 12;
    const trees = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => {
      const a = rand() * Math.PI * 2;
      const r = rand() * radius * 0.7;
      return { x: Math.cos(a) * r, z: Math.sin(a) * r, s: 0.8 + rand() };
    });
    return {
      x: Math.cos(angle) * dist,
      y,
      z: Math.sin(angle) * dist,
      radius,
      seed: Math.floor(rand() * 1e9),
      trees,
      bob: rand() * Math.PI * 2,
      spin: (rand() - 0.5) * 0.02,
    };
  });
}

export const leafGeometry = new THREE.ConeGeometry(1.3, 3.2, 6);
export const trunkGeometry = new THREE.CylinderGeometry(0.2, 0.25, 1, 5);
export const leafMaterial = inSeason(
  new THREE.MeshLambertMaterial({
    color: "#2d6b3a",
    flatShading: true,
  }),
  "needles",
);
export const trunkMaterial = inSeason(
  new THREE.MeshLambertMaterial({
    color: "#5a4030",
  }),
);

function DistantIsland({ island }: { island: Distant }) {
  const group = useRef<THREE.Group>(null);
  const geometry = useMemo(
    () => islandGeometry(island.radius, island.radius * 1.3, island.seed),
    [island],
  );
  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    const t = clock.elapsedTime;
    g.position.y = island.y + Math.sin(t * 0.25 + island.bob) * 0.8;
    g.rotation.y = island.bob + t * island.spin;
  });
  return (
    <group ref={group} position={[island.x, island.y, island.z]}>
      <mesh geometry={geometry} material={islandMaterial} />
      {island.trees.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed, seeded set
        <group key={i} position={[t.x, 0, t.z]} scale={t.s}>
          <mesh
            geometry={leafGeometry}
            material={leafMaterial}
            position-y={2.4}
          />
          <mesh
            geometry={trunkGeometry}
            material={trunkMaterial}
            position-y={0.5}
          />
        </group>
      ))}
    </group>
  );
}

/** The other islands, out in the sky. */
export function DistantIslands({
  avoid = [],
}: {
  /** Where the islands you can visit float (each [x, y, z] and radius):
   * no made-up island drifts through one. */
  avoid?: { at: readonly number[]; radius: number }[];
}) {
  const key = JSON.stringify(avoid);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on content
  const islands = useMemo(
    () =>
      scatterIslands().filter((d) =>
        avoid.every(
          (a) =>
            Math.hypot(d.x - a.at[0], d.z - a.at[2]) > d.radius + a.radius + 25,
        ),
      ),
    [key],
  );
  return (
    <>
      {islands.map((island) => (
        <DistantIsland key={island.seed} island={island} />
      ))}
    </>
  );
}
