import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// The Crystal's parts — plinth, crystal, orbiting shards, halo, motes, the
// attune ring — as plain three.js, shared by the one in Town (Crystal.tsx)
// and its portrait in the Crystal's window (CrystalView.tsx). Each copy brings
// its own uniforms, so the portrait never steps on the Town's.

/** What a Crystal's materials read: the clock, how full it is (fill /
 * capacity, above 1 when overcharged) and the attune flash (1 to 0). */
export type CrystalUniforms = {
  uTime: { value: number };
  uCharge: { value: number };
  uBurst: { value: number };
};

/** Where the crystal floats, over the plinth's top. */
export const FLOAT_Y = 1.75;
export const PLINTH_R = 0.85;

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
export const PLINTH_GEOMETRY = plinthGeometry();

/** The crystal's half-width and half-height. */
export const CRYSTAL_R = 0.42;
export const CRYSTAL_H = CRYSTAL_R * 1.9;

/** The crystal: a long octahedron, flat-faceted. */
export const CRYSTAL_GEOMETRY = new THREE.OctahedronGeometry(CRYSTAL_R, 0)
  .scale(1, 1.9, 1)
  .toNonIndexed();
/** The same, turned an eighth so a facet faces the front (+z) instead of an
 * edge: the portrait's face sits on it. */
export const FACING_CRYSTAL_GEOMETRY = CRYSTAL_GEOMETRY.clone().rotateY(
  Math.PI / 4,
);
/** Small shards that orbit it. */
export const SHARD_GEOMETRY = new THREE.OctahedronGeometry(0.11, 0)
  .scale(1, 1.8, 1)
  .toNonIndexed();

const DIM = new THREE.Color("#3a5f8a");
const LIT = new THREE.Color("#7fe8ff");
const HOT = new THREE.Color("#f2fbff");

/** The portrait's face, read by crystalMaterial({ face: true }). */
export type CrystalFaceUniforms = {
  /** Eyes shut: 0 open, 1 closed (a blink, or asleep). */
  uBlink: { value: number };
  /** Happy ^ ^ eyes, 0 to 1 (full, or booped). */
  uJoy: { value: number };
  /** Mouth open, 0 to 1 (talking, surprised). */
  uMouth: { value: number };
  /** Blush, 0 to 1. */
  uBlush: { value: number };
};

export function crystalFaceUniforms(): CrystalFaceUniforms {
  return {
    uBlink: { value: 0 },
    uJoy: { value: 0 },
    uMouth: { value: 0 },
    uBlush: { value: 0 },
  };
}

/** Facets lit by the charge: deep blue when empty, glassy aqua as it fills,
 * near white and shimmering once overcharged. A rim light keeps the shape
 * readable at night. With `face` (the portrait, on FACING_CRYSTAL_GEOMETRY):
 * a little face on the front facet and a glint sweeping across now and
 * then. */
export function crystalMaterial(
  u: CrystalUniforms,
  face?: CrystalFaceUniforms,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      ...u,
      ...(face ?? {}),
      uDim: { value: DIM },
      uLit: { value: LIT },
      uHot: { value: HOT },
    },
    defines: face ? { FACE: "" } : {},
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vPos;
      varying float vH;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vH = position.y;
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
      uniform float uBurst;
      uniform vec3 uDim;
      uniform vec3 uLit;
      uniform vec3 uHot;
      #ifdef FACE
      uniform float uBlink;
      uniform float uJoy;
      uniform float uMouth;
      uniform float uBlush;
      #endif
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vPos;
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
        #ifdef FACE
        // A glint sweeping up across the facets every few seconds.
        // (On the crystal a fifth of the time; off past its top the rest.)
        float sweep = fract(uTime * 0.22) * 9.0 - 1.2;
        float glint = 1.0 - step(0.035, abs(vPos.x * 0.6 + vPos.y - sweep));
        col = mix(col, uHot, glint * (0.25 + 0.4 * fill));
        // The face, on the front facets (+z), in the facet's own x/y.
        if (vPos.z > 0.05) {
          vec3 ink = vec3(0.004, 0.008, 0.035);
          vec2 p = vPos.xy;
          // Eyes: tall ovals, squashed shut by a blink; happy, they're
          // little ^ arches instead.
          for (int i = 0; i < 2; i++) {
            vec2 e = p - vec2(i == 0 ? -0.105 : 0.105, 0.11);
            // Shut, a line a pixel thick and a little wider.
            float h = max(0.075 * (1.0 - uBlink), 0.026);
            float open = step(abs(e.x), 0.045 + 0.02 * uBlink) * step(abs(e.y), h);
            float arch = step(abs(e.x), 0.075)
              * step(abs(e.y - (0.035 - abs(e.x) * 0.9)), 0.028);
            float eye = mix(open, arch, uJoy);
            col = mix(col, ink, eye);
            // A catchlight in each open eye.
            float catchlight = step(abs(e.x + 0.012), 0.016)
              * step(abs(e.y - h * 0.45), 0.02) * (1.0 - uJoy) * step(uBlink, 0.4);
            col = mix(col, vec3(1.0), catchlight);
            // Blush below and outside each eye.
            vec2 b = p - vec2(i == 0 ? -0.19 : 0.19, -0.015);
            col = mix(col, vec3(1.0, 0.55, 0.72), uBlush * 0.8
              * step(length(b * vec2(1.0, 1.6)), 0.05));
          }
          // Mouth: a small smile, opening to an "o".
          vec2 m = p - vec2(0.0, -0.035);
          float smile = step(abs(m.x), 0.05)
            * step(abs(m.y - (m.x * m.x * 9.0 - 0.012)), 0.018);
          float o = step(length(m * vec2(1.0, 0.8)), 0.035 + 0.02 * uMouth);
          col = mix(col, ink, mix(smile, o, step(0.15, uMouth)));
        }
        #endif
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

/**
 * How the glow's colour lands. In Town, added onto the opaque scene. On the
 * portrait's transparent canvas, additive with alpha 1 would leave an opaque
 * black square round every glow, so there it's premultiplied colour and
 * alpha, drawn over what's behind.
 */
function glowBlending(
  premultiplied: boolean,
): Partial<THREE.ShaderMaterialParameters> {
  return premultiplied
    ? {
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
        defines: { PREMULTIPLIED: "" },
      }
    : { blending: THREE.AdditiveBlending };
}

/** A soft glow behind it, always facing the camera. Premultiplied (the
 * portrait): in three hard steps, a pixel-art glow. */
export function haloMaterial(
  u: CrystalUniforms,
  premultiplied = false,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, uLit: { value: LIT } },
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
        a = max(a, 0.0);
        #ifdef PREMULTIPLIED
        // Hard steps, faint: a ring of glow round it, not a wash over it.
        a = floor(min(a, 1.0) * 3.0) / 3.0 * 0.3;
        gl_FragColor = vec4(uLit * a, a);
        #else
        gl_FragColor = vec4(uLit * a, 1.0);
        #endif
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    ...glowBlending(premultiplied),
  });
}
export const HALO_GEOMETRY = new THREE.PlaneGeometry(3.2, 3.2);

/** Motes drifting up and round it. More of them, and quicker, the fuller it
 * is: a mote only shows if its seed is under the charge. */
export function motesMaterial(
  u: CrystalUniforms,
  premultiplied = false,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, uLit: { value: LIT } },
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
        #ifdef PREMULTIPLIED
        // One crisp pixel, on or off: a sparkle, not a smudge.
        a = step(0.6, vAlpha);
        gl_FragColor = vec4(mix(uLit, vec3(1.0), 0.6) * a, a);
        #else
        gl_FragColor = vec4(mix(uLit, vec3(1.0), 0.5) * a, 1.0);
        #endif
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    ...glowBlending(premultiplied),
  });
}
export const MOTES = 64;
export const MOTE_GEOMETRY = (() => {
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
export function ringMaterial(u: CrystalUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uBurst: u.uBurst, uLit: { value: LIT } },
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
export const RING_GEOMETRY = new THREE.PlaneGeometry(2, 2).rotateX(
  -Math.PI / 2,
);

/** Where the three orbiting shards sit, round the crystal. */
export const SHARD_SPOTS = [0, 1, 2].map((i) => {
  const a = (i / 3) * Math.PI * 2;
  return {
    position: [Math.cos(a) * 0.75, (i - 1) * 0.18, Math.sin(a) * 0.75] as const,
    tilt: 0.3 * (i - 1),
  };
});
