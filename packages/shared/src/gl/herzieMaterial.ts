import * as THREE from "three";
import type { PrimitiveShading } from "../creature-renderer.js";

/** Where a herzie's light comes from and what colour it is: uniforms shared
 * by reference, so a host (the Town's day cycle) moves them for every herzie
 * at once. */
export type HerzieLighting = {
  /** Unit vector toward the light, in world space. */
  uSun: THREE.IUniform<THREE.Vector3>;
  /** Tint over the bands' own colours (white: as painted). */
  uLight: THREE.IUniform<THREE.Color>;
  /** Little lights nearby (a lamp post, a lit window), each a world
   * position and its strength (0: off); up to MAX_LAMPS. */
  uLamps?: THREE.IUniform<THREE.Vector4[]>;
  /** Their colour. */
  uLampColor?: THREE.IUniform<THREE.Color>;
};

/** The most little lights a herzie is lit by. */
export const MAX_LAMPS = 24;
/** How far a little light reaches. */
export const LAMP_REACH = 7;

/** A set of little lights, all off. */
export function noLamps(): THREE.Vector4[] {
  return Array.from({ length: MAX_LAMPS }, () => new THREE.Vector4());
}

/** A herzie on its own (Home, a profile): lit like the ray caster lit it,
 * from up and to the left of the viewer, in plain white light. */
export const studioLighting: HerzieLighting = {
  uSun: { value: new THREE.Vector3(-0.45, 0.7, 0.55).normalize() },
  uLight: { value: new THREE.Color(1, 1, 1) },
};

/** Uniforms every part of one herzie shares, so the herzie sets them all at
 * once: the world height where its colour scheme's top band starts and how
 * tall the painted span is, and how greyed out and see-through it is. */
export type SchemeUniforms = {
  uTop: THREE.IUniform<number>;
  uSpan: THREE.IUniform<number>;
  /** 0 in colour to 1 fully grey. */
  uGrey: THREE.IUniform<number>;
  uOpacity: THREE.IUniform<number>;
};

/** Most bands a scheme can have (its ramp is uploaded as 3 shades each). */
const MAX_BANDS = 8;

const vertexShader = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>
varying vec3 vWorldNormal;
varying vec3 vLocalNormal;
varying float vWorldY;
varying vec3 vWorldPos;
void main() {
  // The geometry's own normal is in creature space (y down), the space the
  // ray caster's textures are laid out in.
  vLocalNormal = normal;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldY = worldPosition.y;
  vWorldPos = worldPosition.xyz;
  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  // What three's shadow chunk reads, by these names.
  vec3 transformedNormal = normalMatrix * normal;
  #include <shadowmap_vertex>
  #include <fog_vertex>
}
`;

// Ports renderCreatureFrame's shading (see primitiveShading) and its
// applyTexture, lit by the host's light (the Town's sun, or a studio light).
const fragmentShader = /* glsl */ `
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
uniform vec3 uSun;
uniform vec3 uLight;
uniform float uGain;
uniform float uFloor;
uniform float uLo;
uniform float uHi;
uniform int uTexture;
uniform vec3 uShades[3];
uniform bool uScheme;
uniform int uBands;
uniform vec3 uRamp[${MAX_BANDS * 3}];
uniform float uTop;
uniform float uSpan;
uniform float uGrey;
uniform float uOpacity;
uniform vec4 uLamps[${MAX_LAMPS}];
uniform vec3 uLampColor;
varying vec3 vWorldNormal;
varying vec3 vLocalNormal;
varying float vWorldY;
varying vec3 vWorldPos;

// How much the little lights nearby light this point: each by how close,
// and how squarely it faces it.
float lampLight(vec3 n) {
  float sum = 0.0;
  for (int i = 0; i < ${MAX_LAMPS}; i++) {
    vec4 lamp = uLamps[i];
    if (lamp.w <= 0.0) continue;
    vec3 to = lamp.xyz - vWorldPos;
    float dist = length(to);
    float fall = clamp(1.0 - dist / ${LAMP_REACH.toFixed(1)}, 0.0, 1.0);
    sum += lamp.w * fall * fall * (0.35 + 0.65 * max(0.0, dot(n, to / max(dist, 0.001))));
  }
  return sum;
}

// Spots (texture 1) aren't drawn in the Town: laid out on the body rather
// than the view, they read as stains.
float pattern(vec3 n) {
  float phi = asin(clamp(n.y, -1.0, 1.0));
  if (uTexture == 2) return sin(phi * 10.0) > 0.2 ? 0.1 : 0.0;
  if (uTexture == 3) return (n.y * 0.5 + 0.5) * 0.12 - 0.06;
  return 0.0;
}

void main() {
  // In the shade of something, a part drops to its darker bands.
  float d = max(0.0, dot(normalize(vWorldNormal), uSun)) * getShadowMask();
  float lit = (uGain + pattern(normalize(vLocalNormal))) * (uFloor + (1.0 - uFloor) * d);
  int shade = lit > uHi ? 2 : lit > uLo ? 1 : 0;
  vec3 color;
  if (uScheme) {
    float t = clamp((uTop - vWorldY) / uSpan, 0.0, 0.9999);
    int band = int(floor(t * float(uBands)));
    color = uRamp[band * 3 + shade];
  } else {
    color = uShades[shade];
  }
  color *= uLight + uLampColor * lampLight(normalize(vWorldNormal));
  color = mix(color, vec3(dot(color, vec3(0.2126, 0.7152, 0.0722))), uGrey);
  gl_FragColor = vec4(color, uOpacity);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/**
 * A herzie part's material: the ray caster's three-tone bands, so a herzie
 * in the Town is coloured like it is everywhere else, but lit by the sun.
 * `ramp` (the scheme's shades per band, top first) and `scheme` are only
 * used when the shading is scheme-painted.
 */
export function herzieMaterial(
  shading: PrimitiveShading,
  textureType: number,
  ramp: [string, string, string][] | null,
  scheme: SchemeUniforms,
  lighting: HerzieLighting = studioLighting,
): THREE.ShaderMaterial {
  const painted = shading.schemePainted && !!ramp;
  const rampColors = Array.from(
    { length: MAX_BANDS * 3 },
    () => new THREE.Color(),
  );
  if (painted) {
    ramp.slice(0, MAX_BANDS).forEach((band, i) => {
      for (let j = 0; j < 3; j++) rampColors[i * 3 + j].set(band[j]);
    });
  }
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    fog: true,
    // Only for the sun's shadow map: the colour is the bands' own.
    lights: true,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
      // Shared: the day cycle moves the sun for every herzie at once.
      uSun: lighting.uSun,
      // Shared: the day cycle dims every herzie at once.
      uLight: lighting.uLight,
      // Shared too: the Town lights its lamps for every herzie at once.
      uLamps: lighting.uLamps ?? { value: noLamps() },
      uLampColor: lighting.uLampColor ?? { value: new THREE.Color(0, 0, 0) },
      uGain: { value: shading.gain },
      uFloor: { value: shading.floor },
      uLo: { value: shading.lo },
      uHi: { value: Math.min(shading.hi, 1e6) },
      uTexture: { value: shading.textured ? textureType : 0 },
      uShades: { value: shading.shades.map((hex) => new THREE.Color(hex)) },
      uScheme: { value: painted },
      uBands: { value: painted ? Math.min(ramp.length, MAX_BANDS) : 1 },
      uRamp: { value: rampColors },
      // Shared by reference: the herzie updates them once for all its parts.
      uTop: scheme.uTop,
      uSpan: scheme.uSpan,
      uGrey: scheme.uGrey,
      uOpacity: scheme.uOpacity,
    },
  });
}
