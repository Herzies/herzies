import { mulberry32 } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

/** The sky, top to bottom: the fog fades everything far off into the
 * horizon colour, so distant islands melt into it. */
export const SKY = {
  top: "#0d1630",
  horizon: "#33507a",
  bottom: "#141f3a",
};

/** The sky dome's colours, top to bottom, and where the sun is (the
 * moon is opposite), as live uniforms (see DayLight). */
export const skyUniforms = {
  uTop: { value: new THREE.Color(SKY.top) },
  uHorizon: { value: new THREE.Color(SKY.horizon) },
  uBottom: { value: new THREE.Color(SKY.bottom) },
  uSunDir: { value: new THREE.Vector3(0, -1, 0) },
  uSunColor: { value: new THREE.Color("#fff4e0") },
};

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

const islandMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
});

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
        uniforms: skyUniforms,
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
          uniform vec3 uSunColor;
          varying vec3 vDir;
          // Angular radii, as cosines: the sun about 2.6 degrees, the moon 1.8.
          const float SUN_DISC = 0.99897;
          const float MOON_DISC = 0.99951;
          void main() {
            vec3 dir = normalize(vDir);
            float h = dir.y;
            vec3 c = h > 0.0
              ? mix(uHorizon, uTop, smoothstep(0.0, 0.6, h))
              : mix(uHorizon, uBottom, smoothstep(0.0, 0.5, -h));
            // Both set behind the horizon, which cuts their discs off.
            if (h > 0.0) {
              float toSun = dot(dir, uSunDir);
              float toMoon = -toSun;
              float sunUp = smoothstep(-0.08, 0.02, uSunDir.y);
              // A wide warm glow, then a hard-edged disc that stays crisp
              // in the Town's chunky pixels.
              vec3 sun = mix(uSunColor, vec3(1.0, 0.98, 0.9), 0.55);
              c += uSunColor * pow(max(toSun, 0.0), 48.0) * 0.35 * sunUp;
              c = mix(c, sun, step(SUN_DISC, toSun) * sunUp);
              float moonUp = smoothstep(-0.08, 0.02, -uSunDir.y);
              c += vec3(0.55, 0.62, 0.8) * pow(max(toMoon, 0.0), 200.0) * 0.25 * moonUp;
              c = mix(c, vec3(0.88, 0.9, 0.96), step(MOON_DISC, toMoon) * moonUp);
            }
            gl_FragColor = vec4(c, 1.0);
            #include <colorspace_fragment>
          }
        `,
      }),
    [],
  );
  const sky = useRef<THREE.Mesh>(null);
  // Centred on the camera, so it is always at the horizon's distance.
  useFrame(({ camera }) => sky.current?.position.copy(camera.position));
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
export const leafMaterial = new THREE.MeshLambertMaterial({
  color: "#2d6b3a",
  flatShading: true,
});
export const trunkMaterial = new THREE.MeshLambertMaterial({
  color: "#5a4030",
});

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
export function DistantIslands() {
  const islands = useMemo(scatterIslands, []);
  return (
    <>
      {islands.map((island) => (
        <DistantIsland key={island.seed} island={island} />
      ))}
    </>
  );
}
