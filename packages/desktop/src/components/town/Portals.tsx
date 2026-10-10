import { useFrame } from "@react-three/fiber";
import { CuboidCollider } from "@react-three/rapier";
import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ambient, seeThrough } from "./ambient";
import type { TownMap } from "./map";
import { type Portal, portalsOf } from "./portal";
import { distortionMaterial, distortionScene } from "./vfx/distortion";

/**
 * Portals as they stand: a weathered stone arch, a disc of swirling light
 * in it — the air round it bending (see vfx/distortion.ts) — and motes
 * spiralling in. Walking through is handled by the Town's Systems.
 */

/** The disc: its middle's height, and its radius. */
export const DISC_Y = 1.55;
const DISC_R = 1.08;
const PILLAR = { w: 0.42, h: 2.55, d: 0.5, x: 1.32 } as const;

const STONE = "#8d8a99";
const STONE_DARK = "#6c6879";
const RUNE = "#c9a6ff";

function colored(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(colors, i * 3);
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.deleteAttribute("uv");
  return geo;
}

/** The arch: two pillars on footings, an arc of stones over them, a
 * keystone with a glowing rune. Facing +z. */
function archGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const pillar = new THREE.BoxGeometry(PILLAR.w, PILLAR.h, PILLAR.d);
    pillar.translate(side * PILLAR.x, PILLAR.h / 2 + 0.12, 0);
    parts.push(colored(pillar, STONE));
    const foot = new THREE.BoxGeometry(PILLAR.w + 0.22, 0.24, PILLAR.d + 0.22);
    foot.translate(side * PILLAR.x, 0.12, 0);
    parts.push(colored(foot, STONE_DARK));
  }
  // The arc: a ring of blocks over the top.
  const blocks = 9;
  const r = PILLAR.x;
  const top = PILLAR.h + 0.12;
  for (let i = 0; i <= blocks; i++) {
    const a = (i / blocks) * Math.PI;
    const b = new THREE.BoxGeometry(0.5, 0.44, PILLAR.d);
    b.rotateZ(a - Math.PI / 2);
    b.translate(Math.cos(a) * r, top + Math.sin(a) * r * 0.62, 0);
    parts.push(colored(b, i % 2 ? STONE : STONE_DARK));
  }
  const key = new THREE.BoxGeometry(0.4, 0.5, PILLAR.d + 0.08);
  key.translate(0, top + r * 0.62 + 0.04, 0);
  parts.push(colored(key, STONE_DARK));
  const rune = new THREE.OctahedronGeometry(0.12);
  rune.translate(0, top + r * 0.62 + 0.04, PILLAR.d / 2 + 0.06);
  parts.push(colored(rune, RUNE));
  return mergeGeometries(parts);
}

const archGeo = archGeometry();
// Dithers away when it's between the camera and the herzie, like the
// trees and houses do.
const archMaterial = seeThrough(
  new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
);

/** The swirl: light spiralling in to the middle, brightest at the rim,
 * through the haze like everything else. */
function discMaterial(tint: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: ambient.uTime,
      uTint: { value: tint },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      uniform vec3 uTint;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                   mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        if (r > 1.0) discard;
        float a = atan(p.y, p.x);
        // Spiralling in: the angle twists more toward the middle.
        float swirl = a + 3.2 / (r + 0.35) - uTime * 1.6;
        float bands = noise(vec2(swirl * 2.0, r * 3.0 - uTime * 0.7));
        bands += 0.5 * noise(vec2(swirl * 5.0, r * 7.0 + uTime));
        float rim = smoothstep(0.72, 0.98, r) * (1.0 - smoothstep(0.98, 1.0, r));
        float core = 1.0 - smoothstep(0.0, 0.55, r);
        vec3 deep = uTint * 0.35;
        vec3 bright = mix(uTint, vec3(1.0), 0.55);
        vec3 color = mix(deep, bright, smoothstep(0.55, 1.25, bands));
        color += bright * rim * 1.1 + vec3(1.0, 0.95, 1.0) * core * 0.35;
        gl_FragColor = vec4(color, 0.88);
        #include <fog_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: true,
  });
}

/** Motes spiralling into the disc, worked out on the GPU from the time. */
function motesMaterial(tint: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: ambient.uTime, uTint: { value: tint } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute float aSeed;
      varying float vAlpha;
      void main() {
        float t = fract(uTime * 0.35 + aSeed);
        float a = aSeed * 40.0 + t * 7.0;
        float r = mix(2.2, 0.05, t * t);
        vec3 p = vec3(cos(a) * r, sin(a) * r, (1.0 - t) * 0.9 * sign(fract(aSeed * 7.3) - 0.5));
        vAlpha = smoothstep(0.0, 0.15, t) * (1.0 - smoothstep(0.85, 1.0, t));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = max(1.0, 0.05 * 200.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTint;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = (1.0 - smoothstep(0.2, 0.5, length(c))) * vAlpha;
        gl_FragColor = vec4(mix(uTint, vec3(1.0), 0.6) * a, 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

const MOTES = 48;
const moteGeometry = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(MOTES * 3), 3),
  );
  const seeds = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i++) seeds[i] = i / MOTES + Math.random() * 0.02;
  g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  return g;
})();

const discGeometry = new THREE.CircleGeometry(DISC_R, 48);
const ringGeometry = new THREE.TorusGeometry(DISC_R * 1.02, 0.16, 8, 40);
const TINT = new THREE.Color("#a77cff");

function PortalArch({ portal, live }: { portal: Portal; live: boolean }) {
  const disc = useMemo(() => discMaterial(TINT), []);
  const motes = useMemo(() => motesMaterial(TINT), []);
  // The air round the disc, rippling: in the distortion buffer.
  const ripple = useMemo(() => {
    const m = new THREE.InstancedMesh(ringGeometry, distortionMaterial(), 1);
    const fx = new THREE.InstancedBufferAttribute(
      new Float32Array([0.6, 0]),
      2,
    );
    m.geometry = ringGeometry.clone();
    m.geometry.setAttribute("aFx", fx);
    m.frustumCulled = false;
    return { mesh: m, fx };
  }, []);
  useLayoutEffect(() => {
    if (!live) return;
    distortionScene.add(ripple.mesh);
    return () => {
      distortionScene.remove(ripple.mesh);
    };
  }, [live, ripple]);
  useLayoutEffect(
    () => () => {
      disc.dispose();
      motes.dispose();
      ripple.mesh.geometry.dispose();
      (ripple.mesh.material as THREE.Material).dispose();
    },
    [disc, motes, ripple],
  );
  const place = useMemo(() => {
    const m = new THREE.Matrix4();
    return {
      m,
      q: new THREE.Quaternion(),
      p: new THREE.Vector3(),
      s: new THREE.Vector3(),
    };
  }, []);
  useFrame(({ clock }) => {
    if (!live) return;
    const t = clock.elapsedTime;
    const pulse = 1 + Math.sin(t * 2.4) * 0.05;
    place.p.set(portal.x, DISC_Y, portal.z);
    place.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), portal.yaw);
    place.s.setScalar(pulse);
    ripple.mesh.setMatrixAt(0, place.m.compose(place.p, place.q, place.s));
    ripple.mesh.instanceMatrix.needsUpdate = true;
    ripple.fx.setX(0, 0.55 + Math.sin(t * 3.1) * 0.15);
    ripple.fx.needsUpdate = true;
  });
  return (
    <group position={[portal.x, 0, portal.z]} rotation-y={portal.yaw}>
      <mesh
        geometry={archGeo}
        material={archMaterial}
        castShadow
        receiveShadow
      />
      <mesh geometry={discGeometry} material={disc} position-y={DISC_Y} />
      <points
        geometry={moteGeometry}
        material={motes}
        position-y={DISC_Y}
        frustumCulled={false}
      />
    </group>
  );
}

/** Every portal on the map. `live`: the island you're on (its portals
 * bend the air; the others' are just seen). */
export function Portals({
  map,
  live = false,
}: {
  map: TownMap;
  live?: boolean;
}) {
  const portals = useMemo(() => portalsOf(map), [map]);
  return (
    <>
      {portals.map((p) => (
        <PortalArch key={p.key} portal={p} live={live} />
      ))}
    </>
  );
}

/** The pillars are solid; the way through isn't. */
export function PortalColliders({ map }: { map: TownMap }) {
  const portals = useMemo(() => portalsOf(map), [map]);
  return (
    <>
      {portals.flatMap((p) =>
        [-1, 1].map((side) => {
          const c = Math.cos(p.yaw);
          const s = Math.sin(p.yaw);
          // The pillar's local +x, turned by yaw: (cos, -sin).
          return (
            <CuboidCollider
              key={`o${p.key}${side}`}
              args={[PILLAR.w / 2 + 0.05, PILLAR.h / 2, PILLAR.d / 2 + 0.05]}
              position={[
                p.x + c * side * PILLAR.x,
                PILLAR.h / 2,
                p.z - s * side * PILLAR.x,
              ]}
              rotation={[0, p.yaw, 0]}
            />
          );
        }),
      )}
    </>
  );
}
