import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// The Hunt Crystal's parts (see HuntCrystal.tsx) as plain three.js: the
// cradle of rock it floats in, the crystal, its glow and motes, the ring
// that rolls out when it's full, and the arc of light it throws to the
// cache. Unlike the Town's Crystal it starts as nothing much: a lump of
// grey stone, still and unlit. Listening fills it with gold from the foot
// up (the line between is the meter), and the fuller it is the faster it
// turns and the brighter it glows. Full, it blazes.

/** What its materials read: the clock, how full it is (0 to 1), whether
 * the hunt's on (0 to 1, eased) and the burst when it fills (1 to 0). */
export type HuntUniforms = {
  uTime: { value: number };
  uCharge: { value: number };
  uHunt: { value: number };
  uBurst: { value: number };
};

/** Where the crystal floats, over the cradle's dais. */
export const HUNT_FLOAT_Y = 2.15;
/** The dais's radius (and its collider's). */
export const HUNT_DAIS_R = 1.05;
/** The crystal's half-width and half-height. */
const R = 0.5;
const H = 0.95;

const SLATE = "#5a564e";
const SLATE_LIGHT = "#6d685f";
const SLATE_DARK = "#48453f";
/** The prongs' tips: gold gone dull, like everything else here. */
const TARNISH = "#8f7a45";

const DULL = new THREE.Color("#6e6a62");
const GOLD = new THREE.Color("#ffc61a");
const HOT = new THREE.Color("#fff6d6");

/** Paint a part one colour, for merging. */
function part(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute("uv");
  const c = new THREE.Color(color);
  const colors = new Float32Array(out.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) {
    colors[i] = c.r;
    colors[i + 1] = c.g;
    colors[i + 2] = c.b;
  }
  out.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return out;
}

/** The cradle: a stepped octagonal dais of dark slate, three crooked
 * prongs of rock reaching up round where the crystal floats (their tips
 * dull gold), and stones at the foot. */
function cradleGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    part(
      new THREE.CylinderGeometry(
        HUNT_DAIS_R,
        HUNT_DAIS_R * 1.12,
        0.26,
        8,
      ).translate(0, 0.13, 0),
      SLATE,
    ),
    part(
      new THREE.CylinderGeometry(HUNT_DAIS_R * 0.72, HUNT_DAIS_R * 0.82, 0.2, 8)
        .rotateY(Math.PI / 8)
        .translate(0, 0.36, 0),
      SLATE_LIGHT,
    ),
  ];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    const r = HUNT_DAIS_R * 0.62;
    // A prong: a lower shaft leaning out, an upper one curling back in
    // under the crystal's waist, a tarnished tip.
    const lower = new THREE.CylinderGeometry(0.08, 0.15, 0.9, 5)
      .translate(0, 0.45, 0)
      .rotateZ(-0.22);
    const upper = new THREE.CylinderGeometry(0.05, 0.09, 0.55, 5)
      .translate(0, 0.27, 0)
      .rotateZ(0.42)
      .translate(0.2, 0.86, 0);
    const tip = new THREE.ConeGeometry(0.06, 0.2, 5)
      .translate(0, 0.1, 0)
      .rotateZ(0.65)
      .translate(0.0, 1.34, 0);
    for (const [g, hex] of [
      [lower, i % 2 ? SLATE : SLATE_DARK],
      [upper, SLATE],
      [tip, TARNISH],
    ] as const)
      parts.push(
        part(
          g.rotateY(-a).translate(Math.cos(a) * r, 0.4, Math.sin(a) * r),
          hex,
        ),
      );
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const r = HUNT_DAIS_R * 1.2;
    parts.push(
      part(
        new THREE.DodecahedronGeometry(0.12 + (i % 3) * 0.05)
          .scale(1, 0.65, 1)
          .translate(Math.cos(a) * r, 0.05, Math.sin(a) * r),
        i % 2 ? SLATE_DARK : SLATE_LIGHT,
      ),
    );
  }
  return mergeGeometries(parts) as THREE.BufferGeometry;
}
export const CRADLE_GEOMETRY = cradleGeometry();

/** The crystal: a six-sided spindle, a long point down and a short one
 * up, flat-faceted. */
export const HUNT_CRYSTAL_GEOMETRY = (() => {
  const g = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.001, -H),
      new THREE.Vector2(R * 0.92, -H * 0.3),
      new THREE.Vector2(R, H * 0.2),
      new THREE.Vector2(0.001, H),
    ],
    6,
  ).toNonIndexed();
  g.computeVertexNormals();
  return g;
})();

/**
 * The crystal's facets. Dull grey stone, a little mottled, above the
 * charge; gold below it, rising from the foot, with a bright seam rippling
 * along the line between. The fuller, the quicker the gold pulses and the
 * stronger the rim glows. The hunt on: all of it blazing, gold flickering
 * to white. The burst: a flash of white.
 */
export function huntCrystalMaterial(u: HuntUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      ...u,
      uDull: { value: DULL },
      uGold: { value: GOLD },
      uHot: { value: HOT },
      uHalf: { value: H },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vPos;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vPos = position;
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
      uniform float uHunt;
      uniform float uBurst;
      uniform vec3 uDull;
      uniform vec3 uGold;
      uniform vec3 uHot;
      uniform float uHalf;
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vPos;
      void main() {
        float fill = clamp(uCharge, 0.0, 1.0);
        float facet = 0.5 + 0.5 * max(0.0, dot(vNormal, normalize(vec3(0.4, 0.8, 0.5))));
        // Stone: mottled in coarse flecks.
        vec3 cell = floor(vPos * 10.0);
        float fleck = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        vec3 col = uDull * facet * (0.82 + 0.18 * fleck);
        // Gold from the foot (0) to the tip (1), up to the charge; the line
        // ripples as it rises.
        float h = (vPos.y + uHalf) / (2.0 * uHalf);
        float rising = step(0.001, fill) * (1.0 - uHunt);
        float level = fill + 0.025 * sin(uTime * 3.0 + vPos.x * 14.0 + vPos.z * 11.0) * rising;
        float pulse = 0.5 + 0.5 * sin(uTime * mix(1.5, 6.0, fill) - h * 4.0);
        vec3 gold = uGold * (0.7 + 0.4 * facet) * (0.85 + 0.35 * pulse * fill);
        col = mix(col, gold, step(h, level));
        // Above the line, the odd fleck already catching the light.
        col = mix(col, uGold, step(0.985 - fill * 0.06, fleck) * step(level, h) * fill);
        // The seam where gold meets stone.
        float seam = 1.0 - smoothstep(0.0, 0.03, abs(h - level));
        col = mix(col, uHot, seam * rising);
        // Rim: nothing on the dull stone, strong once it's full.
        float rim = pow(1.0 - max(0.0, dot(vNormal, vView)), 2.0);
        col += uGold * rim * fill * fill * 0.9;
        // The hunt's on: blazing, gold flickering to white up and down it.
        float blaze = 0.5 + 0.5 * sin(uTime * 9.0 + vPos.y * 7.0);
        col = mix(col, mix(uGold * 1.3, uHot, blaze), uHunt * 0.65);
        col = mix(col, uHot, uBurst);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
    fog: true,
  });
}

/** A soft gold glow round it, always facing the camera: none at all while
 * it's dull, growing as it fills, big and throbbing once the hunt's on. */
export function huntHaloMaterial(u: HuntUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, uGold: { value: GOLD } },
    vertexShader: /* glsl */ `
      uniform float uHunt;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mv.xy += position.xy * (1.0 + uHunt * 0.8);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uCharge;
      uniform float uHunt;
      uniform float uBurst;
      uniform vec3 uGold;
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float fill = clamp(uCharge, 0.0, 1.0);
        float pulse = 0.8 + 0.2 * sin(uTime * mix(1.5, 6.0, fill));
        float throb = 0.75 + 0.25 * sin(uTime * 5.0);
        float a = 1.0 - smoothstep(0.0, 1.0, r);
        a = a * a * (0.55 * fill * fill * pulse + 0.7 * uHunt * throb) + uBurst * (1.0 - r);
        gl_FragColor = vec4(uGold * max(a, 0.0), 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
export const HUNT_HALO_GEOMETRY = new THREE.PlaneGeometry(3.6, 3.6);

/** Gold motes spiralling up round it: none while it's dull, more and
 * quicker the fuller it is, a fountain of them once the hunt's on. */
export function huntMotesMaterial(u: HuntUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, uGold: { value: GOLD } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uCharge;
      uniform float uHunt;
      attribute float aSeed;
      varying float vAlpha;
      void main() {
        float fill = clamp(uCharge, 0.0, 1.0);
        float speed = mix(0.1, 0.45, fill) + uHunt * 0.4;
        float t = fract(uTime * speed + aSeed * 13.0);
        float a = aSeed * 60.0 + t * (3.0 + uHunt * 4.0);
        float r = mix(1.1, 0.3, t) * (1.0 + uHunt * 0.6) + 0.15 * sin(aSeed * 91.0);
        vec3 p = vec3(cos(a) * r, -1.6 + t * (2.8 + uHunt * 3.0), sin(a) * r);
        float shown = step(aSeed, fill * 0.85 + uHunt * 0.15) * step(0.001, fill);
        vAlpha = shown * smoothstep(0.0, 0.2, t) * (1.0 - smoothstep(0.7, 1.0, t));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = max(1.0, (0.07 + uHunt * 0.04) * 200.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uGold;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = (1.0 - smoothstep(0.15, 0.5, length(c))) * vAlpha;
        gl_FragColor = vec4(mix(uGold, vec3(1.0), 0.4) * a, 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
const MOTES = 96;
export const HUNT_MOTE_GEOMETRY = (() => {
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

/** The ring of gold that rolls out across the ground as it fills. */
export function huntRingMaterial(u: HuntUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uBurst: u.uBurst, uGold: { value: GOLD } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uBurst;
      uniform vec3 uGold;
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float band = smoothstep(0.8, 0.95, r) * (1.0 - smoothstep(0.95, 1.0, r));
        gl_FragColor = vec4(uGold * band * uBurst * 1.5, 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
export const HUNT_RING_GEOMETRY = new THREE.PlaneGeometry(2, 2).rotateX(
  -Math.PI / 2,
);

/** How high the arc to the cache rises over the island at its middle, at
 * least, and for each unit it spans. */
const ARC_RISE = 14;
const ARC_RISE_PER = 0.18;

/** The way from the crystal to the cache, `from` and `to` in the island's
 * frame: up out of the crystal, over the trees, down onto the cache. Its
 * tube's u runs along it, crystal (0) to cache (1); the light only ever
 * goes part of the way (see huntArcMaterial). */
export function huntArcGeometry(
  from: THREE.Vector3,
  to: THREE.Vector3,
): THREE.TubeGeometry {
  const span = Math.hypot(to.x - from.x, to.z - from.z);
  const mid = from
    .clone()
    .lerp(to, 0.5)
    .setY(Math.max(from.y, to.y) + ARC_RISE + span * ARC_RISE_PER);
  const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
  return new THREE.TubeGeometry(curve, 96, 0.22, 6, false);
}

/** The arc's light: pulses streaming along it away from the crystal,
 * drawn out from it (to `uGrow` along the way, 0 to 1) when it fills,
 * fading out over its last stretch, and faded (`uOn`) when the hunt's
 * over. Soft at its sides. Additive, never written to depth. */
export function huntArcMaterial(u: HuntUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: u.uTime,
      uGold: { value: GOLD },
      uGrow: { value: 0 },
      uOn: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying float vAlong;
      varying float vFacing;
      void main() {
        vAlong = uv.x;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFacing = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uGold;
      uniform float uGrow;
      uniform float uOn;
      varying float vAlong;
      varying float vFacing;
      void main() {
        float flow = fract(vAlong * 9.0 - uTime * 1.4);
        float pulse = smoothstep(0.0, 0.12, flow) * (1.0 - smoothstep(0.12, 0.45, flow));
        float head = 1.0 - smoothstep(uGrow - 0.12, uGrow, vAlong);
        float ends = smoothstep(0.0, 0.03, vAlong);
        float a = (0.3 + 0.7 * pulse) * head * ends * uOn * vFacing * vFacing;
        gl_FragColor = vec4(mix(uGold, vec3(1.0), pulse * 0.5) * a, 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}
