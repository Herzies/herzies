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
 * from up, to the right and in front of the viewer (its LIGHT, turned out
 * of creature space), in plain white light. */
export const studioLighting: HerzieLighting = {
  uSun: { value: new THREE.Vector3(0.4, 0.6, 0.8).normalize() },
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
  /** A wash of colour over the whole herzie (rgb, and how much in w): a
   * hit's flash, an enrage's red. */
  uFlash: THREE.IUniform<THREE.Vector4>;
};

/** How much a lamp's light counts toward a part's bands, against the
 * sun's (whose full face-on light is 1). */
const LAMP_BANDS = 1.6;

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
#ifdef METAL
varying vec3 vAround;
varying vec3 vAxis;
varying float vRho;
#endif
void main() {
  #ifdef METAL
  // Round its axis (the geometry's y), the way a lathe turned it: its
  // grooves run this way.
  vAround = mat3(modelMatrix) * vec3(-position.z, 0.0, position.x);
  vAxis = mat3(modelMatrix) * vec3(0.0, 1.0, 0.0);
  vRho = length(position.xz);
  #endif
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
uniform vec4 uFlash;
uniform vec4 uLamps[${MAX_LAMPS}];
uniform vec3 uLampColor;
varying vec3 vWorldNormal;
varying vec3 vLocalNormal;
varying float vWorldY;
varying vec3 vWorldPos;
#ifdef METAL
uniform float uRadius;
varying vec3 vAround;
varying vec3 vAxis;
varying float vRho;
#endif

// The sun's (or moon's) shadow, and only its: three's own shadow mask
// multiplies in every shadow-casting light's, so a lamp's shadow would
// darken the moonlight too. As that mask's directional branch.
float sunShadow() {
  float shadow = 1.0;
  #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
  DirectionalLightShadow directionalLight;
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
    directionalLight = directionalLightShadows[ i ];
    shadow *= receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLight.shadowMapSize, directionalLight.shadowIntensity, directionalLight.shadowBias, directionalLight.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
  }
  #pragma unroll_loop_end
  #endif
  return shadow;
}

// How much the little lights nearby light this point: each by how close,
// and how squarely it faces it. \`facing\` is the same without the wrap
// round the sides: how lit it is for its bands.
float lampLight(vec3 n, out float facing) {
  float sum = 0.0;
  facing = 0.0;
  for (int i = 0; i < ${MAX_LAMPS}; i++) {
    vec4 lamp = uLamps[i];
    if (lamp.w <= 0.0) continue;
    vec3 to = lamp.xyz - vWorldPos;
    float dist = length(to);
    float fall = clamp(1.0 - dist / ${LAMP_REACH.toFixed(1)}, 0.0, 1.0);
    float squarely = max(0.0, dot(n, to / max(dist, 0.001)));
    sum += lamp.w * fall * fall * (0.35 + 0.65 * squarely);
    facing += lamp.w * fall * fall * squarely;
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

#ifdef METAL
// Polished metal, cel style: dark in itself, it shows what it mirrors —
// bright sky over a dark horizon line and the ground — in hard bands, a
// rim where it turns away, and, where its lathe grooves catch the sun, a
// bright bar across it through its middle (a cymbal's shine). \`paint\` is
// its banded colour, \`shadow\` the sun's.
vec3 polished(vec3 paint, vec3 n, float shadow) {
  vec3 v = normalize(cameraPosition - vWorldPos);
  float rho = vRho / uRadius;
  // Its colour, richer: a coloured metal tints all it mirrors.
  vec3 tint = pow(uShades[2], vec3(1.35)) * 1.15;
  // Mirrored as if it bulged far more than it does, so the world sweeps
  // across its face — sky, horizon, ground — rather than lying flat on it
  // as one tone.
  vec3 outward = cross(vAxis, vAround);
  float ol = length(outward);
  vec3 bent = ol > 1e-5 ? normalize(n + outward / ol * rho * 1.1) : n;
  // The sky above, warm white at its height; darkest just under the
  // horizon; the ground lighter again below. Narrow steps keep the bands
  // hard but unaliased.
  float up = reflect(-v, bent).y;
  vec3 sky = mix(tint * 1.05, tint * 0.75 + vec3(0.4, 0.36, 0.28), smoothstep(0.38, 0.44, up));
  vec3 horizon = tint * tint * 0.35;
  vec3 ground = tint * 0.52;
  vec3 env = up > 0.0
    ? mix(horizon, sky, smoothstep(0.03, 0.09, up))
    : mix(horizon, ground, 1.0 - smoothstep(-0.2, -0.14, up));
  vec3 color = mix(paint * 0.4, env, 0.8);

  // The grooves' glint: sharp across them, drawn out along the radius, so
  // it lies as a bar through the middle and slides round as the view does
  // (anisotropic, after Ward). Faded at the middle, where "round" has no
  // direction.
  vec3 h = normalize(uSun + v);
  vec3 t = vAround - n * dot(vAround, n);
  float tl = length(t);
  float glint = 0.0;
  float nh = max(dot(n, h), 0.0);
  if (tl > 1e-5 && nh > 0.0) {
    t /= tl;
    vec3 b = cross(n, t);
    float th = dot(t, h) / 0.09;
    float bh = dot(b, h) / 0.95;
    glint = exp(-(th * th + bh * bh) / (nh * nh));
  }
  // The grooves themselves, fine rings that break the bar up as it runs
  // out; gone where they'd be finer than a pixel.
  float ringPhase = rho * 70.0;
  float rings = 1.0 - 0.3 * (0.5 + 0.5 * sin(ringPhase * 6.2832))
    * clamp(1.5 - fwidth(ringPhase) * 2.0, 0.0, 1.0);
  float sunLit = max(dot(n, uSun), 0.0) * shadow;
  float bar = glint * rings * sunLit * smoothstep(0.06, 0.2, rho);
  color = mix(color, tint * 1.5 + 0.2, smoothstep(0.12, 0.24, bar));
  color += vec3(1.0, 0.97, 0.9) * smoothstep(0.55, 0.7, bar);

  // A rim where it turns away, mirroring the bright sky round it.
  float rim = 1.0 - max(dot(n, v), 0.0);
  color += tint * smoothstep(0.55, 0.75, rim * rim) * 0.35;
  return color;
}
#endif

void main() {
  vec3 n = normalize(vWorldNormal);
  float lampFacing;
  float lamps = lampLight(n, lampFacing);
  // In the shade of something, a part drops to its darker bands — unless
  // a lamp nearby lights it.
  float shadow = sunShadow();
  float d = max(
    max(0.0, dot(n, uSun)) * shadow,
    min(1.0, lampFacing * ${LAMP_BANDS.toFixed(2)})
  );
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
  #ifdef METAL
  color = polished(color, n, shadow);
  #endif
  color *= uLight + uLampColor * lamps;
  color = mix(color, vec3(dot(color, vec3(0.2126, 0.7152, 0.0722))), uGrey);
  color = mix(color, uFlash.rgb, uFlash.w);
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
  /** Metal only: how far its grooves run from its axis (its radius). */
  metalRadius = 1,
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
    defines: shading.metal ? { METAL: "" } : {},
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
      uFlash: scheme.uFlash,
      uRadius: { value: metalRadius },
    },
  });
}
