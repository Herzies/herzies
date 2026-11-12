import { mulberry32 } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { ambient } from "./ambient";
import {
  BLEND_RADIUS,
  cellCenter,
  elevation,
  groundBlend,
  inland,
  isOpenWater,
  isSunk,
  TERRAIN,
  type TownMap,
  terrainAt,
  wetAtHeight,
} from "./map";

/** Where the water's surface sits (the ground is at 0, ponds' beds lower). */
export const SURFACE = -0.15;
const SHORE_WET = wetAtHeight(SURFACE);
/** Each water cell's surface is this many quads a side, so it can ripple. */
const SPLIT = 8;
/** How far from the bank foam reaches. */
const FOAM = 0.3;
const MAX_SHORE = 2;

/** How far a point is from the bank: how far past the shoreline (where
 * the sloping ground goes under the surface) the blend is, in world units —
 * 0 on dry ground. */
export function shoreDistance(map: TownMap, x: number, z: number): number {
  const { wet } = groundBlend(map, x, z);
  const d = (wet - SHORE_WET) * 2 * BLEND_RADIUS;
  return Math.min(MAX_SHORE, Math.max(0, d));
}

/** Whether a cell gets water over it: it's sunk, or beside one that is —
 * the banks curve out a little past a pond's cells, and the ground hides
 * the surface wherever it's higher. */
function underWater(map: TownMap, col: number, row: number): boolean {
  // Whole cells only: one past the rim would stick out of the island's side.
  if (!inland(map, col, row)) return false;
  for (let r = row - 1; r <= row + 1; r++) {
    for (let c = col - 1; c <= col + 1; c++) {
      if (isSunk(terrainAt(map, c, r))) return true;
    }
  }
  return false;
}

/** The water's surface over the ponds, finely split so it can ripple,
 * each vertex knowing how far it is from the bank (for foam). */
export function waterGeometry(map: TownMap): THREE.BufferGeometry {
  const pos: number[] = [];
  const shore: number[] = [];
  const step = 1 / SPLIT;
  const HALF = map.size / 2;
  const vertex = (x: number, z: number) => {
    pos.push(x, elevation(map, x, z) + SURFACE, z);
    shore.push(shoreDistance(map, x, z));
  };
  for (let row = 0; row < map.size; row++) {
    for (let col = 0; col < map.size; col++) {
      if (!underWater(map, col, row)) continue;
      for (let i = 0; i < SPLIT; i++) {
        for (let j = 0; j < SPLIT; j++) {
          const x0 = col - HALF + i * step;
          const z0 = row - HALF + j * step;
          vertex(x0, z0);
          vertex(x0, z0 + step);
          vertex(x0 + step, z0 + step);
          vertex(x0, z0);
          vertex(x0 + step, z0 + step);
          vertex(x0 + step, z0);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("shore", new THREE.Float32BufferAttribute(shore, 1));
  g.computeVertexNormals();
  return g;
}

/** Translucent water that ripples, with glints drifting over it and a line
 * of foam along the banks. Lambert underneath, so it's lit and fogged
 * like everything else. */
function waterMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({
    color: TERRAIN["~"].color,
    transparent: true,
    opacity: 0.8,
    flatShading: true,
  });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, ambient, { uFoam: { value: FOAM } });
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
uniform float uTime;
uniform float uIce;
uniform float uRain;
const float ICE_RISE = ${(-SURFACE - 0.02).toFixed(3)};
attribute float shore;
varying float vShore;
varying vec2 vWorldXZ;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
vec4 wp = modelMatrix * vec4( transformed, 1.0 );
vWorldXZ = wp.xz;
vShore = shore;
// Small, slow ripples — flat at the bank, so the water meets it.
float calm = smoothstep( 0.0, 0.6, shore ) * ( 1.0 - uIce );
// Frozen: the ice rises level with the banks, where you walk on it.
transformed.y += uIce * ICE_RISE;
transformed.y += calm * 0.035 * (
  sin( wp.x * 1.7 + uTime * 1.3 ) + sin( wp.z * 2.1 - uTime * 1.1 )
);
// Rain on it (see weather): a quick restless chop on top.
transformed.y += calm * uRain * 0.025 * sin( wp.x * 7.3 + wp.z * 5.1 + uTime * 9.0 );`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
uniform float uTime;
uniform float uFoam;
uniform float uIce;
uniform float uRain;
// Smooth value noise: random heights on a grid, eased between.
float hash21( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}
float noise2( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( hash21( i ), hash21( i + vec2( 1.0, 0.0 ) ), u.x ),
    mix( hash21( i + vec2( 0.0, 1.0 ) ), hash21( i + vec2( 1.0, 1.0 ) ), u.x ),
    u.y
  );
}
varying float vShore;
varying vec2 vWorldXZ;`,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
// Glints: two layers of noise drifting different ways (one warped by a
// third), so where they both peak moves about irregularly — sparkles
// come and go in random spots rather than marching across in rows.
vec2 p = vWorldXZ;
vec2 warp = vec2( noise2( p * 0.6 + uTime * 0.11 ), noise2( p * 0.6 - uTime * 0.09 + 7.3 ) );
float n1 = noise2( p * 1.9 + warp * 1.6 + vec2( uTime * 0.21, uTime * 0.07 ) );
float n2 = noise2( p * 3.1 - warp + vec2( -uTime * 0.05, uTime * 0.26 ) + 19.1 );
float glint = smoothstep( 0.7, 0.88, n1 * n2 * 1.25 );
// Far off, a glint's smaller than a pixel and only flickers: those fade
// to a faint even sheen instead.
vec2 gpx = fwidth( p );
float glintFar = smoothstep( 0.12, 0.35, max( gpx.x, gpx.y ) );
diffuseColor.rgb += mix( glint, 0.05, glintFar * 0.8 ) * 0.18 * ( 1.0 - uRain * 0.7 );
// Raindrops: pale specks landing here and there, each gone in a blink.
if ( uRain > 0.0 ) {
  float tick = floor( uTime * 10.0 );
  float drop = step( 1.0 - uRain * 0.06, hash21( floor( p * 6.0 ) + tick * 0.37 ) );
  diffuseColor.rgb += drop * 0.35 * ( 1.0 - glintFar );
}
// The bank, drawn the way shorelines usually are: the edge is warped by
// noise so it never reads as a contour, the water fades from clear in the
// shallows to deep, and foam comes as a few layers — a wet line at the
// edge, a broken band lapping out, and a swash line that slides back
// down the bank and fades.
float warp1 = noise2( p * 2.7 + vec2( uTime * 0.12, -uTime * 0.09 ) );
float warp2 = noise2( p * 6.5 - vec2( uTime * 0.2, uTime * 0.15 ) + 3.7 );
float nd = vShore + ( warp1 - 0.5 ) * 0.22 + ( warp2 - 0.5 ) * 0.07;
// Depth tint: sunlit turquoise in the shallows, the pond's own colour deeper.
float deep = smoothstep( 0.04, 0.5, nd );
vec3 shallow = vec3( 0.26, 0.52, 0.6 );
diffuseColor.rgb = mix( shallow, diffuseColor.rgb, deep );
// See the bed through the shallows: nearly clear at the edge.
diffuseColor.a = mix( 0.25, diffuseColor.a, smoothstep( 0.0, 0.3, nd ) );
// Caustics: bright net lines on the shallows, drifting.
float cA = noise2( p * 4.2 + vec2( uTime * 0.25, uTime * 0.18 ) );
float cB = noise2( p * 4.2 * 1.3 - vec2( uTime * 0.2, -uTime * 0.23 ) + 11.0 );
float caustic = smoothstep( 0.0, 0.06, 0.06 - abs( cA - cB ) );
diffuseColor.rgb += caustic * ( 1.0 - deep ) * 0.2 * ( 1.0 - uIce );
// Foam: wet line right at the edge, wobbling.
float lap = uFoam * ( 0.7 + 0.3 * sin( uTime * 1.6 + p.x * 2.3 + p.y * 1.7 ) );
float edgeFoam = 1.0 - smoothstep( 0.0, 0.07 + 0.05 * warp2, nd );
// Broken band, lapping out and in, eaten into by fine noise.
float bandBreak = smoothstep( 0.42, 0.62, noise2( p * 9.0 + uTime * 0.15 ) + ( 1.0 - nd / lap ) * 0.35 );
float band = ( 1.0 - smoothstep( lap * 0.55, lap, nd ) ) * bandBreak;
// Swash: a thin line that rolls up the bank, thins and fades.
float ph = fract( uTime * 0.16 + warp1 * 0.6 );
float swashAt = ( 1.0 - ph ) * lap * 1.6;
float swash = ( 1.0 - smoothstep( 0.0, 0.035 + 0.03 * ph, abs( nd - swashAt ) ) )
  * ( 1.0 - ph ) * smoothstep( 0.35, 0.6, noise2( p * 7.0 + 5.0 ) );
float foam = clamp( edgeFoam + band * 0.7 + swash * 0.8, 0.0, 1.0 );
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.9, 0.95, 0.98 ), foam * 0.85 );
diffuseColor.a = mix( diffuseColor.a, 0.95, foam );
// Frozen over (see Seasons.ts): pale and still, with a few cracks, and
// frosted white towards the bank.
if ( uIce > 0.0 ) {
  float crack = 1.0 - smoothstep( 0.0, 0.035, abs( noise2( p * 0.9 ) - 0.5 ) );
  float frost = 1.0 - smoothstep( 0.0, 0.5, vShore );
  vec3 ice = mix( vec3( 0.5, 0.64, 0.76 ), vec3( 0.78, 0.84, 0.9 ), frost );
  ice = mix( ice, vec3( 0.86, 0.9, 0.95 ), crack * 0.7 );
  diffuseColor.rgb = mix( diffuseColor.rgb, ice, uIce );
  diffuseColor.a = mix( diffuseColor.a, 0.97, uIce );
}`,
      );
  };
  m.customProgramCacheKey = () => "town-water";
  return m;
}

/** How many fish rings can be out at once, and how long each lasts. */
const RINGS = 3;
const RING_LIFE = 1.8;
const ringGeometry = new THREE.RingGeometry(0.85, 1, 24).rotateX(-Math.PI / 2);

/** Now and then, a fish: a ring spreading out on open water. */
function FishRings({ map }: { map: TownMap }) {
  const spots = useMemo(() => {
    const out: [number, number][] = [];
    for (let row = 0; row < map.size; row++) {
      for (let col = 0; col < map.size; col++) {
        if (isOpenWater(map, col, row)) out.push(cellCenter(map, col, row));
      }
    }
    return out;
  }, [map]);
  const meshes = useRef<(THREE.Mesh | null)[]>([]);
  const state = useRef(
    Array.from({ length: RINGS }, (_, i) => ({ born: -10, wait: 1 + i * 2.5 })),
  );
  const rand = useMemo(() => mulberry32(4242), []);
  const materials = useMemo(
    () =>
      Array.from(
        { length: RINGS },
        () =>
          new THREE.MeshBasicMaterial({
            color: "#dcecf6",
            transparent: true,
            opacity: 0,
            depthWrite: false,
          }),
      ),
    [],
  );

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    state.current.forEach((s, i) => {
      const mesh = meshes.current[i];
      if (!mesh) return;
      const age = t - s.born;
      if (age > RING_LIFE + s.wait && spots.length > 0) {
        // Next fish, somewhere else, a while from now.
        const [x, z] = spots[Math.floor(rand() * spots.length)];
        mesh.position.set(
          x + (rand() - 0.5) * 0.5,
          elevation(map, x, z) + SURFACE + 0.02,
          z + (rand() - 0.5) * 0.5,
        );
        s.born = t;
        s.wait = 2 + rand() * 6;
        return;
      }
      const k = Math.min(1, age / RING_LIFE);
      // No fish under the ice.
      mesh.visible = k < 1 && ambient.uIce.value < 0.5;
      mesh.scale.setScalar(0.1 + k * 0.6);
      materials[i].opacity = (1 - k) * 0.7;
    });
  });

  if (spots.length === 0) return null;
  return (
    <>
      {materials.map((m, i) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed pool
          key={i}
          ref={(el) => {
            meshes.current[i] = el;
          }}
          geometry={ringGeometry}
          material={m}
          visible={false}
        />
      ))}
    </>
  );
}

/** The ponds and streams' surface, and the odd fish. */
export function Water({ map }: { map: TownMap }) {
  const geometry = useMemo(() => waterGeometry(map), [map]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  const material = useMemo(waterMaterial, []);
  return (
    <>
      <mesh geometry={geometry} material={material} />
      <FishRings map={map} />
    </>
  );
}
