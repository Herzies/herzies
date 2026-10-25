import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { ambient } from "./ambient";
import { isMouth, usePortalOpen } from "./gates";
import type { TownMap } from "./map";
import { type Portal, portalsOf } from "./portal";
import { townSave } from "./runtime";
import { distortionMaterial, distortionScene } from "./vfx/distortion";

/**
 * Portals as they stand: a disc of swirling light floating in the air, the
 * air round it bending (see vfx/distortion.ts), and motes spiralling in.
 * Nothing stands round it and nothing is in the way. Walking through is
 * handled by the Town's Systems.
 */

/** The disc: its middle's height, and its radius. */
export const DISC_Y = 1.55;
const DISC_R = 1.08;

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
        float r = mix(1.12, 0.05, t * t);
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
/** A cave's mouth glows the boss's colour instead. */
const MOUTH_TINT = new THREE.Color("#ff5a4a");

/** A portal into a room (the boss's cave) glows the boss's colour. */
export { isMouth };

/** How near you have to be for the air round a portal to ripple. */
const RIPPLE_REACH = 25;

function PortalDisc({ portal, live }: { portal: Portal; live: boolean }) {
  const mouth = isMouth(portal);
  const tint = mouth ? MOUTH_TINT : TINT;
  const disc = useMemo(() => discMaterial(tint), [tint]);
  const motes = useMemo(() => motesMaterial(tint), [tint]);
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
    // Too far off to see the air bend: skip the distortion pass's work.
    ripple.mesh.visible =
      Math.hypot(townSave.x - portal.x, townSave.z - portal.z) < RIPPLE_REACH;
    if (!ripple.mesh.visible) return;
    const t = clock.elapsedTime;
    const pulse = 1 + Math.sin(t * 2.4) * 0.05;
    place.p.set(portal.x, portal.y + DISC_Y, portal.z);
    place.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), portal.yaw);
    place.s.setScalar(pulse);
    ripple.mesh.setMatrixAt(0, place.m.compose(place.p, place.q, place.s));
    ripple.mesh.instanceMatrix.needsUpdate = true;
    ripple.fx.setX(0, 0.55 + Math.sin(t * 3.1) * 0.15);
    ripple.fx.needsUpdate = true;
  });
  return (
    <group position={[portal.x, portal.y, portal.z]} rotation-y={portal.yaw}>
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
  // The cave's mouth is there only while the cave is open, the Tower's
  // door while it's on, its way on once the floor's clear.
  const isOpen = usePortalOpen();
  const all = useMemo(() => portalsOf(map), [map]);
  const portals = all.filter(isOpen);
  return (
    <>
      {portals.map((p) => (
        <PortalDisc key={p.key} portal={p} live={live} />
      ))}
    </>
  );
}
