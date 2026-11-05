import { useFrame } from "@react-three/fiber";
import { CylinderCollider } from "@react-three/rapier";
import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ambient, inSeason } from "./ambient";
import { crystalAlwaysShown, crystalLive, useCrystal } from "./crystalState";
import { cellCenter, groundY, objectAt, type TownMap } from "./map";
import { townSave } from "./runtime";

// The Crystal: a faceted crystal floating over a stone plinth. Listening
// charges it (see @herzies/shared crystal.ts); walk up and press E to attune
// and take what it's holding. It is its own meter — the glow, the pulse and
// the motes round it grow as it fills, so you can read it from across Town.

/** The map char for the Crystal ("quartz"). Painted with Q in the editor. */
export const CRYSTAL = "Q";

/** Where a Crystal stands. */
export type CrystalSpot = { x: number; y: number; z: number };

/** Every Crystal on the map. */
export function crystalsOf(map: TownMap): CrystalSpot[] {
  const out: CrystalSpot[] = [];
  for (let row = 0; row < map.size; row++)
    for (let col = 0; col < map.size; col++) {
      if (objectAt(map, col, row) !== CRYSTAL) continue;
      const [x, z] = cellCenter(map, col, row);
      out.push({ x, y: groundY(map, x, z), z });
    }
  return out;
}

/** How close you need to be to attune. */
export const CRYSTAL_REACH = 2.8;

/** The Crystal within reach, nearest first (null: none). */
export function crystalNear(
  crystals: readonly CrystalSpot[],
  x: number,
  z: number,
): CrystalSpot | null {
  let best: CrystalSpot | null = null;
  let reach = CRYSTAL_REACH;
  for (const c of crystals) {
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < reach) {
      reach = d;
      best = c;
    }
  }
  return best;
}

const uCharge = { value: 0 };
const uBurst = { value: 0 };

/** Where the crystal floats, over the plinth's top. */
const FLOAT_Y = 1.75;
const PLINTH_R = 0.85;

/** Paint a part one colour, for merging. */
function part(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute("uv");
  const c = new THREE.Color(color);
  out.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(
      Array.from(
        { length: out.attributes.position.count * 3 },
        (_, i) => [c.r, c.g, c.b][i % 3],
      ),
      3,
    ),
  );
  return out;
}

/** The plinth: two stepped hexagons of stone with a few rocks at the foot. */
function plinthGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    part(
      new THREE.CylinderGeometry(PLINTH_R, PLINTH_R * 1.1, 0.3, 6).translate(
        0,
        0.15,
        0,
      ),
      "#8f8a94",
    ),
    part(
      new THREE.CylinderGeometry(PLINTH_R * 0.7, PLINTH_R * 0.8, 0.5, 6)
        .rotateY(Math.PI / 6)
        .translate(0, 0.55, 0),
      "#a39fab",
    ),
    part(
      new THREE.CylinderGeometry(PLINTH_R * 0.5, PLINTH_R * 0.62, 0.12, 6)
        .rotateY(Math.PI / 6)
        .translate(0, 0.86, 0),
      "#7d7887",
    ),
  ];
  // Rocks round the foot, and a few small shards grown out of them.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    const r = PLINTH_R * 1.15;
    parts.push(
      part(
        new THREE.DodecahedronGeometry(0.14 + (i % 2) * 0.06)
          .scale(1, 0.7, 1)
          .translate(Math.cos(a) * r, 0.06, Math.sin(a) * r),
        i % 2 ? "#8a8592" : "#9c97a3",
      ),
    );
  }
  return mergeGeometries(parts) as THREE.BufferGeometry;
}
const PLINTH_GEOMETRY = plinthGeometry();

const plinthMaterial = inSeason(
  new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
);

/** The crystal: a long octahedron, flat-faceted. */
const CRYSTAL_GEOMETRY = (() => {
  const g = new THREE.OctahedronGeometry(0.42, 0).scale(1, 1.9, 1);
  return g.toNonIndexed();
})();
/** Small shards that orbit it. */
const SHARD_GEOMETRY = new THREE.OctahedronGeometry(0.11, 0)
  .scale(1, 1.8, 1)
  .toNonIndexed();

const DIM = new THREE.Color("#3a5f8a");
const LIT = new THREE.Color("#7fe8ff");
const HOT = new THREE.Color("#f2fbff");

/** Facets lit by the charge: deep blue when empty, glassy aqua as it fills,
 * near white and shimmering once overcharged. A rim light keeps the shape
 * readable at night. */
function crystalMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: ambient.uTime,
      uCharge,
      uBurst,
      uDim: { value: DIM },
      uLit: { value: LIT },
      uHot: { value: HOT },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vH;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vH = position.y;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vView = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      uniform float uCharge;
      uniform float uBurst;
      uniform vec3 uDim;
      uniform vec3 uLit;
      uniform vec3 uHot;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vH;
      void main() {
        float fill = clamp(uCharge, 0.0, 1.0);
        float over = clamp(uCharge - 1.0, 0.0, 1.0);
        // Faster pulse the fuller it is.
        float pulse = 0.5 + 0.5 * sin(uTime * mix(1.2, 3.6, fill));
        vec3 base = mix(uDim, uLit, fill);
        // Facet shading: a fixed key light so the facets read.
        float facet = 0.55 + 0.45 * max(0.0, dot(vNormal, normalize(vec3(0.4, 0.8, 0.5))));
        vec3 col = base * facet;
        // Light rising through it, stronger with the charge.
        float band = smoothstep(-0.8, 0.8, vH) * (0.25 + 0.75 * fill);
        col += uLit * band * (0.25 + 0.35 * pulse) * fill;
        // Overcharged: a slow white shimmer.
        col = mix(col, uHot, over * (0.25 + 0.25 * sin(uTime * 5.0 + vH * 6.0)));
        // Rim.
        float rim = pow(1.0 - max(0.0, dot(vNormal, vView)), 2.0);
        col += uLit * rim * (0.35 + 0.65 * fill);
        // The attune flash.
        col = mix(col, uHot, uBurst);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
    fog: true,
  });
}

/** A soft glow behind it, always facing the camera. */
function haloMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: ambient.uTime, uCharge, uBurst, uLit: { value: LIT } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        // Billboard: keep the quad square to the camera.
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mv.xy += position.xy;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uCharge;
      uniform float uBurst;
      uniform vec3 uLit;
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float fill = clamp(uCharge, 0.0, 1.3);
        float pulse = 0.85 + 0.15 * sin(uTime * mix(1.2, 3.6, min(fill, 1.0)));
        float a = (1.0 - smoothstep(0.0, 1.0, r));
        a = a * a * (0.08 + 0.5 * fill * pulse) + uBurst * (1.0 - r);
        gl_FragColor = vec4(uLit * max(a, 0.0), 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
const HALO_GEOMETRY = new THREE.PlaneGeometry(3.2, 3.2);

/** Motes drifting up and round it. More of them, and quicker, the fuller it
 * is: a mote only shows if its seed is under the charge. */
function motesMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: ambient.uTime, uCharge, uLit: { value: LIT } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uCharge;
      attribute float aSeed;
      varying float vAlpha;
      void main() {
        float fill = clamp(uCharge, 0.0, 1.5);
        float speed = mix(0.12, 0.4, min(fill, 1.0)) + max(0.0, fill - 1.0) * 0.4;
        float t = fract(uTime * speed + aSeed * 13.0);
        float a = aSeed * 60.0 + t * 3.0;
        float r = mix(0.95, 0.35, t) + 0.15 * sin(aSeed * 91.0);
        vec3 p = vec3(cos(a) * r, -1.4 + t * 2.6, sin(a) * r);
        float shown = step(aSeed, 0.08 + fill * 0.92);
        vAlpha = shown * smoothstep(0.0, 0.2, t) * (1.0 - smoothstep(0.7, 1.0, t));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = max(1.0, 0.06 * 200.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uLit;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = (1.0 - smoothstep(0.15, 0.5, length(c))) * vAlpha;
        gl_FragColor = vec4(mix(uLit, vec3(1.0), 0.5) * a, 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
const MOTES = 64;
const MOTE_GEOMETRY = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(MOTES * 3), 3),
  );
  const seeds = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i++) seeds[i] = (i + 0.5) / MOTES;
  g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  return g;
})();

/** The ring that rolls out along the ground when you attune. */
function ringMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uBurst, uLit: { value: LIT } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uBurst;
      uniform vec3 uLit;
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float band = smoothstep(0.75, 0.95, r) * (1.0 - smoothstep(0.95, 1.0, r));
        gl_FragColor = vec4(uLit * band * uBurst, 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
const RING_GEOMETRY = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);

/** How long the attune flash lasts, seconds. */
const BURST_SECONDS = 1.4;
/** Past this, the crystal and its motes stop animating (still drawn). */
const ANIMATE_REACH = 60;

function OneCrystal({ spot }: { spot: CrystalSpot }) {
  const materials = useMemo(
    () => ({
      crystal: crystalMaterial(),
      halo: haloMaterial(),
      motes: motesMaterial(),
      ring: ringMaterial(),
    }),
    [],
  );
  useLayoutEffect(
    () => () => {
      for (const m of Object.values(materials)) m.dispose();
    },
    [materials],
  );
  const refs = useMemo(
    () => ({
      spin: null as THREE.Group | null,
      shards: null as THREE.Group | null,
      ring: null as THREE.Mesh | null,
    }),
    [],
  );
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    // Ease the charge toward the live value so a sync's jump glides.
    uCharge.value += (crystalLive.charge - uCharge.value) * 0.05;
    const since = performance.now() / 1000 - crystalLive.burstAt;
    const burst =
      since >= 0 && since < BURST_SECONDS
        ? (1 - since / BURST_SECONDS) ** 2
        : 0;
    uBurst.value = burst;
    if (Math.hypot(townSave.x - spot.x, townSave.z - spot.z) > ANIMATE_REACH)
      return;
    const fill = Math.min(1, uCharge.value);
    if (refs.spin) {
      refs.spin.rotation.y = t * (0.25 + fill * 0.5);
      refs.spin.position.y = FLOAT_Y + Math.sin(t * 1.3) * 0.08 + burst * 0.25;
      refs.spin.scale.setScalar(1 + burst * 0.2);
    }
    if (refs.shards) {
      refs.shards.rotation.y = -t * (0.4 + fill * 0.8);
      refs.shards.position.y = FLOAT_Y + Math.sin(t * 0.9) * 0.05;
    }
    if (refs.ring) {
      refs.ring.visible = burst > 0;
      refs.ring.scale.setScalar(0.5 + (1 - burst) * 4);
    }
  });
  return (
    <group position={[spot.x, spot.y, spot.z]}>
      <mesh
        geometry={PLINTH_GEOMETRY}
        material={plinthMaterial}
        castShadow
        receiveShadow
      />
      <group
        ref={(g) => {
          refs.spin = g;
        }}
        position-y={FLOAT_Y}
      >
        <mesh
          geometry={CRYSTAL_GEOMETRY}
          material={materials.crystal}
          castShadow
        />
      </group>
      <group
        ref={(g) => {
          refs.shards = g;
        }}
        position-y={FLOAT_Y}
      >
        {[0, 1, 2].map((i) => {
          const a = (i / 3) * Math.PI * 2;
          return (
            <mesh
              key={i}
              geometry={SHARD_GEOMETRY}
              material={materials.crystal}
              position={[
                Math.cos(a) * 0.75,
                (i - 1) * 0.18,
                Math.sin(a) * 0.75,
              ]}
              rotation-z={0.3 * (i - 1)}
            />
          );
        })}
      </group>
      <mesh
        geometry={HALO_GEOMETRY}
        material={materials.halo}
        position-y={FLOAT_Y}
        frustumCulled={false}
      />
      <points
        geometry={MOTE_GEOMETRY}
        material={materials.motes}
        position-y={FLOAT_Y}
        frustumCulled={false}
      />
      <mesh
        ref={(m) => {
          refs.ring = m;
        }}
        geometry={RING_GEOMETRY}
        material={materials.ring}
        position-y={0.05}
        visible={false}
      />
    </group>
  );
}

/** Every Crystal on the map. */
export function Crystals({ map }: { map: TownMap }) {
  const spots = useMemo(() => crystalsOf(map), [map]);
  // Not there at all until the server turns the Crystal on.
  const enabled = useCrystal()?.enabled === true || crystalAlwaysShown;
  if (!enabled) return null;
  return (
    <>
      {spots.map((s) => (
        <OneCrystal key={`crystal${s.x},${s.z}`} spot={s} />
      ))}
    </>
  );
}

/** The plinth is solid; you attune from beside it. */
export function CrystalColliders({ map }: { map: TownMap }) {
  const spots = useMemo(() => crystalsOf(map), [map]);
  const enabled = useCrystal()?.enabled === true || crystalAlwaysShown;
  if (!enabled) return null;
  return (
    <>
      {spots.map((s) => (
        <CylinderCollider
          key={`crystal${s.x},${s.z}`}
          args={[0.6, PLINTH_R * 0.9]}
          position={[s.x, s.y + 0.6, s.z]}
        />
      ))}
    </>
  );
}
