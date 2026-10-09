import { mulberry32 } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { ambient } from "./ambient";
import {
  cellCenter,
  isOpenWater,
  isSunk,
  MAP_SIZE,
  TERRAIN,
  type TownMap,
  terrainAt,
} from "./map";

/** Where the water's surface sits (the ground is at 0, ponds' beds lower). */
export const SURFACE = -0.15;
/** Each water cell's surface is this many quads a side, so it can ripple. */
const SPLIT = 2;
/** How far from the bank foam reaches. */
const FOAM = 0.25;
const MAX_SHORE = 2;

const HALF = MAP_SIZE / 2;

/** How far a point is from the nearest bank: the nearest cell around it
 * that isn't water. */
export function shoreDistance(map: TownMap, x: number, z: number): number {
  const c0 = Math.floor(x + HALF);
  const r0 = Math.floor(z + HALF);
  let best = MAX_SHORE;
  for (let r = r0 - 2; r <= r0 + 2; r++) {
    for (let c = c0 - 2; c <= c0 + 2; c++) {
      if (isSunk(terrainAt(map, c, r))) continue;
      // Distance to that cell's square.
      const cx = c - HALF;
      const cz = r - HALF;
      const dx = Math.max(cx - x, 0, x - (cx + 1));
      const dz = Math.max(cz - z, 0, z - (cz + 1));
      best = Math.min(best, Math.hypot(dx, dz));
    }
  }
  return best;
}

/** The water's surface over every sunk cell, finely split so it can
 * ripple, each vertex knowing how far it is from the bank (for foam). */
export function waterGeometry(map: TownMap): THREE.BufferGeometry {
  const pos: number[] = [];
  const shore: number[] = [];
  const step = 1 / SPLIT;
  const vertex = (x: number, z: number) => {
    pos.push(x, SURFACE, z);
    shore.push(shoreDistance(map, x, z));
  };
  for (let row = 0; row < MAP_SIZE; row++) {
    for (let col = 0; col < MAP_SIZE; col++) {
      if (!isSunk(terrainAt(map, col, row))) continue;
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
float calm = smoothstep( 0.0, 0.6, shore );
transformed.y += calm * 0.035 * (
  sin( wp.x * 1.7 + uTime * 1.3 ) + sin( wp.z * 2.1 - uTime * 1.1 )
);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
uniform float uTime;
uniform float uFoam;
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
float glint = smoothstep( 0.66, 0.85, n1 * n2 * 1.25 );
diffuseColor.rgb += glint * 0.28;
// Foam at the bank, its edge lapping in and out.
float lap = uFoam * ( 0.75 + 0.25 * sin( uTime * 1.8 + vWorldXZ.x * 2.3 + vWorldXZ.y * 1.7 ) );
float foam = 1.0 - smoothstep( lap * 0.6, lap, vShore );
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.86, 0.93, 0.98 ), foam * 0.8 );
diffuseColor.a = mix( diffuseColor.a, 0.95, foam );`,
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
    for (let row = 0; row < MAP_SIZE; row++) {
      for (let col = 0; col < MAP_SIZE; col++) {
        if (isOpenWater(map, col, row)) out.push(cellCenter(col, row));
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
          SURFACE + 0.02,
          z + (rand() - 0.5) * 0.5,
        );
        s.born = t;
        s.wait = 2 + rand() * 6;
        return;
      }
      const k = Math.min(1, age / RING_LIFE);
      mesh.visible = k < 1;
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
