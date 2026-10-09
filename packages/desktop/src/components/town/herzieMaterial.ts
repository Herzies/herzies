import type { PrimitiveShading } from "@herzies/shared";
import * as THREE from "three";
import { ambient } from "./ambient";
import { SUN_POSITION } from "./runtime";

/** Uniforms every scheme-painted part of one herzie shares, so the herzie
 * moves them all at once: the world height where the scheme's top band
 * starts, and how tall the painted span is. */
export type SchemeUniforms = {
  uTop: THREE.IUniform<number>;
  uSpan: THREE.IUniform<number>;
};

/** Most bands a scheme can have (its ramp is uploaded as 3 shades each). */
const MAX_BANDS = 8;

const SUN = new THREE.Vector3(...SUN_POSITION).normalize();

const vertexShader = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec3 vWorldNormal;
varying vec3 vLocalNormal;
varying float vWorldY;
void main() {
  // The geometry's own normal is in creature space (y down), the space the
  // ray caster's textures are laid out in.
  vLocalNormal = normal;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldY = world.y;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

// Ports renderCreatureFrame's shading (see primitiveShading) and its
// applyTexture, lit by the Town's sun instead of a camera-fixed light.
const fragmentShader = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
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
varying vec3 vWorldNormal;
varying vec3 vLocalNormal;
varying float vWorldY;

// Spots (texture 1) aren't drawn in the Town: laid out on the body rather
// than the view, they read as stains.
float pattern(vec3 n) {
  float phi = asin(clamp(n.y, -1.0, 1.0));
  if (uTexture == 2) return sin(phi * 10.0) > 0.2 ? 0.1 : 0.0;
  if (uTexture == 3) return (n.y * 0.5 + 0.5) * 0.12 - 0.06;
  return 0.0;
}

void main() {
  float d = max(0.0, dot(normalize(vWorldNormal), uSun));
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
  gl_FragColor = vec4(color * uLight, 1.0);
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
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uSun: { value: SUN },
      // Shared: the day cycle dims every herzie at once.
      uLight: ambient.uLight,
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
    },
  });
}
