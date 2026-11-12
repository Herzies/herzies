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
 * once: where its colour scheme's top band starts and how tall the painted
 * span is (creature space, y down, at rest: see `uRestY`), and how greyed
 * out and see-through it is. */
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

/** How much of its own colour glass adds over what's behind it (see the
 * fragment shader's GLASS output). */
const GLASS_GLOW = 0.28;

/** Most bands a scheme can have (its ramp is uploaded as 3 shades each). */
const MAX_BANDS = 8;

const vertexShader = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>
#include <skinning_pars_vertex>
#ifdef PATCH
attribute float coat;
varying float vPatch;
#endif
varying vec3 vWorldNormal;
varying vec3 vLocalNormal;
varying float vRestY;
varying vec3 vWorldPos;
// The part's row of its resting place in creature space (see
// setRestPlace): a point's height there, at rest.
uniform vec4 uRestY;
#ifdef METAL
varying vec3 vAround;
varying vec3 vAxis;
varying float vRho;
#endif
#ifdef CLOTH
varying vec2 vUv;
#endif
void main() {
  #ifdef CLOTH
  vUv = uv;
  #endif
  #ifdef PATCH
  vPatch = coat;
  #endif
  // Bent by its bones on a skinned mesh (the cat); as is otherwise.
  vec3 objectNormal = normal;
  vec3 transformed = position;
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <skinning_vertex>
  #ifdef METAL
  // Round its axis (the geometry's y), the way a lathe turned it: its
  // grooves run this way.
  vAround = mat3(modelMatrix) * vec3(-position.z, 0.0, position.x);
  vAxis = mat3(modelMatrix) * vec3(0.0, 1.0, 0.0);
  vRho = length(position.xz);
  #endif
  // The geometry's own normal is in creature space (y down), the space the
  // ray caster's textures are laid out in.
  vLocalNormal = objectNormal;
  vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
  vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
  // Where its scheme's bands fall: painted on, by where it sits at rest,
  // so they move with the arm swinging or the body leaning through them.
  vRestY = dot(uRestY, vec4(position, 1.0));
  vWorldPos = worldPosition.xyz;
  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  // What three's shadow chunk reads, by these names.
  vec3 transformedNormal = normalMatrix * objectNormal;
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
#ifdef PATCH
// A second coat (the cat's orange), where the geometry's patch says.
uniform vec3 uPatch[3];
varying float vPatch;
#endif
varying vec3 vWorldNormal;
varying vec3 vLocalNormal;
varying float vRestY;
varying vec3 vWorldPos;
#ifdef METAL
uniform float uRadius;
varying vec3 vAround;
varying vec3 vAxis;
varying float vRho;
#endif
#ifdef CLOTH
// A cloak: the outside's bands (uShades), the lining's on the inside, the
// trim's at the collar and hem; and what it's made of (CLOTH_FINISH).
uniform vec3 uLining[3];
uniform vec3 uTrim[3];
uniform int uFinish;
uniform float uHemTrim;
uniform float uCollarTrim;
varying vec2 vUv;

vec3 band3(vec3 shades[3], int shade) {
  return shade == 2 ? shades[2] : shade == 1 ? shades[1] : shades[0];
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Smooth value noise, for a hide's mottling.
float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

// What its stuff does to the light, on top of its bands: \`n\` faces the
// viewer's side of the cloth, \`outside\` whether that's its outside.
vec3 clothFinish(vec3 color, vec3 n, float shadow, bool outside, bool trim) {
  vec3 v = normalize(cameraPosition - vWorldPos);
  vec3 h = normalize(uSun + v);
  float nv = max(dot(n, v), 0.0);
  float nh = max(dot(n, h), 0.0);
  float sunLit = max(dot(n, uSun), 0.0) * shadow;
  if (trim) {
    // Metal thread: a hard glint.
    float glint = pow(nh, 40.0) * sunLit;
    color = mix(color, vec3(1.0, 0.97, 0.88), smoothstep(0.35, 0.6, glint) * 0.7);
    if (uFinish == 3) {
      // Brass studs along the hem.
      float stud = length(vec2(fract(vUv.x * 18.0) - 0.5, (vUv.y - (1.0 - uHemTrim * 0.5)) / uHemTrim * 0.9));
      color = mix(color, uTrim[2] * 1.25 + 0.1, smoothstep(0.32, 0.22, stud));
    }
    return color;
  }
  if (uFinish == 1) {
    // Velvet: the pile catches light where it turns away (a soft glow at
    // the edges of every fold), and soaks it up face on.
    float rim = pow(1.0 - nv, 2.5);
    vec3 pile = outside ? uShades[2] : uLining[2];
    color = color * (0.88 + 0.12 * (1.0 - nv)) + pile * rim * 0.55;
  } else if (uFinish == 2) {
    // Vinyl: glossy, a bright cel highlight broken up by its grooves, which
    // run across it — gone where they'd be finer than a pixel.
    float spec = pow(nh, 60.0) * sunLit;
    float phase = vUv.y * 90.0;
    float grooves = 0.55 + 0.45 * sin(phase * 6.2832)
      * clamp(1.5 - fwidth(phase) * 2.0, 0.0, 1.0);
    float bar = spec * (outside ? grooves : 0.3);
    color = mix(color, vec3(0.92, 0.92, 1.0), smoothstep(0.2, 0.45, bar) * 0.8);
    // And the faint sheen of the grooves everywhere else.
    if (outside) color += vec3(0.05) * grooves * (1.0 - nv);
  } else if (uFinish == 3) {
    // Hide: mottled, matte, a little scuffed.
    float m = noise2(vUv * vec2(9.0, 14.0)) * 0.6 + noise2(vUv * vec2(31.0, 47.0)) * 0.4;
    color *= outside ? 0.84 + 0.3 * m : 0.94 + 0.1 * m;
  } else if (uFinish == 5) {
    // Camo: woodland blotches on the outside, in four tones over the
    // cloth's own olive, each kept to its band's light; the lining plain.
    if (outside) {
      vec2 q = vUv * vec2(4.0, 6.0);
      float a = noise2(q) * 0.65 + noise2(q * 2.3 + 7.1) * 0.35;
      float b = noise2(q * 1.4 + 3.7) * 0.65 + noise2(q * 3.1 + 1.3) * 0.35;
      float c = noise2(q * 1.8 + 11.9);
      float lum = min(1.12, max(color.r, max(color.g, color.b))
        / max(max(uShades[1].r, max(uShades[1].g, uShades[1].b)), 0.001));
      vec3 khaki = vec3(0.56, 0.53, 0.37);
      vec3 brown = vec3(0.42, 0.31, 0.2);
      vec3 forest = vec3(0.24, 0.29, 0.17);
      vec3 black = vec3(0.13, 0.14, 0.1);
      color = mix(color, khaki * lum, step(0.66, a));
      color = mix(color, brown * lum, step(0.6, b));
      color = mix(color, forest * lum, step(0.66, 1.0 - a) * step(0.45, c));
      color = mix(color, black * lum, step(0.74, c) * step(0.5, b));
    }
  } else if (uFinish == 4) {
    // Silk: sky at the collar to teal at the hem, and a broad, soft sheen.
    if (outside) color *= mix(vec3(1.06, 1.04, 1.0), vec3(0.62, 0.95, 0.92), vUv.y);
    float sheen = pow(nh, 9.0) * sunLit;
    color += vec3(0.85, 0.97, 1.0) * smoothstep(0.25, 0.75, sheen) * 0.28;
  }
  return color;
}
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

#ifdef GLASS
// See-through (a translucent skin, see TRANSLUCENT_SKINS): tinted glass,
// cel style. Clear face on and nearly solid at the edges, in two steps,
// the edge a lighter band of its own colour; light coming through from
// behind glows in it; and one hard highlight where it faces the sun, which
// is solid too. Returns how opaque it is; \`color\` is lit in place.
float glassy(inout vec3 color, vec3 n, float shadow) {
  vec3 v = normalize(cameraPosition - vWorldPos);
  vec3 h = normalize(uSun + v);
  float nv = max(dot(n, v), 0.0);
  float edge = smoothstep(0.42, 0.5, 1.0 - nv);
  float rim = smoothstep(0.68, 0.76, 1.0 - nv);
  #ifdef LENS
  // A lens: tinted glass, mostly dark, the eye behind just showing.
  float alpha = mix(0.97, 0.98, edge);
  alpha = mix(alpha, 0.99, rim);
  #else
  float alpha = mix(0.44, 0.68, edge);
  alpha = mix(alpha, 0.9, rim);
  #endif
  // A touch brighter than paint: over something dark, glass this clear
  // would otherwise sink to the dark rather than read as its colour.
  color = min(color * 1.12, vec3(1.0));
  color = mix(color, min(color * 1.3 + 0.06, vec3(1.0)), rim);
  // The sun through it, from behind: a glow in the glass.
  float through = pow(max(dot(-v, uSun), 0.0), 3.0) * shadow;
  color += color * through * 0.45;
  float spec = pow(max(dot(n, h), 0.0), 70.0)
    * max(dot(n, uSun), 0.0) * shadow;
  float shine = smoothstep(0.3, 0.42, spec);
  #ifdef LENS
  // A lens is flat: facing the sun, all of it would catch the highlight
  // at once and go white. Just a faint sheen instead.
  color += vec3(0.12) * shine;
  return alpha;
  #else
  color = mix(color, vec3(1.0), shine);
  return max(alpha, shine);
  #endif
}
#endif

#ifdef MARBLE
float mhash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float mnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(mhash(i), mhash(i + vec3(1, 0, 0)), f.x),
        mix(mhash(i + vec3(0, 1, 0)), mhash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(mhash(i + vec3(0, 0, 1)), mhash(i + vec3(1, 0, 1)), f.x),
        mix(mhash(i + vec3(0, 1, 1)), mhash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z
  );
}
float mfbm(vec3 p) {
  return 0.5 * mnoise(p) + 0.25 * mnoise(p * 2.03) + 0.125 * mnoise(p * 4.01);
}
// Marble, on the pearl itself (its own normal, so the veins stay put as it
// swings): white, with thin black veins and broader, softer pink ones, each
// a sine bent by noise (the classic turbulence marble). Each pearl's veins
// are its own, seeded by its colour (the whites differ a hair).
vec3 marbled(vec3 color) {
  float seed = fract(dot(uShades[1], vec3(12.9898, 78.233, 37.719)) * 43.7585);
  // Broad: a pearl's only a few pixels across, so a vein has to be wide
  // to be seen at all.
  vec3 q = normalize(vLocalNormal) * 1.1 + seed * 9.0;
  float black = abs(sin((q.x * 1.4 + q.y * 0.6) * 1.6 + 2.4 * mfbm(q * 1.5)));
  float pink = abs(sin((q.z * 1.2 - q.x * 0.5) * 1.3 + 2.0 * mfbm(q * 1.2 + 4.7)));
  // Stepped edges, as everything on a herzie is.
  float b = 1.0 - smoothstep(0.2, 0.26, black);
  float p = 1.0 - smoothstep(0.42, 0.5, pink);
  vec3 lum = color / max(max(uShades[1].r, max(uShades[1].g, uShades[1].b)), 0.001);
  color = mix(color, vec3(1.0, 0.42, 0.68) * lum, p * 0.8);
  color = mix(color, vec3(0.1, 0.08, 0.12) * lum, b * 0.9);
  return color;
}
#endif

#ifdef GLOSS
// Polished (patent leather, glossy gold), cel style: its own bands, then
// one hard, bright highlight where it faces the sun, a softer glow round
// it, and a thin bright rim where it turns away, the sky caught in it.
// Stepped, as everything on a herzie is.
vec3 glossy(vec3 color, vec3 n, float shadow) {
  vec3 v = normalize(cameraPosition - vWorldPos);
  vec3 h = normalize(uSun + v);
  float nv = max(dot(n, v), 0.0);
  float nh = max(dot(n, h), 0.0);
  float sunLit = max(dot(n, uSun), 0.0) * shadow;
  float glow = pow(nh, 16.0) * sunLit;
  color = mix(color, min(color * 1.45 + 0.08, vec3(1.0)), smoothstep(0.3, 0.45, glow) * 0.6);
  float spec = pow(nh, 80.0) * sunLit;
  color = mix(color, vec3(1.0, 0.98, 0.95), smoothstep(0.3, 0.42, spec));
  float up = reflect(-v, n).y;
  float rim = smoothstep(0.62, 0.72, 1.0 - nv) * smoothstep(0.0, 0.25, up);
  color = mix(color, min(color * 1.6 + 0.15, vec3(1.0)), rim * 0.7);
  return color;
}
#endif

#ifdef PEARL
// A pearl, cel style: its own dark bands, then what makes it a pearl —
// layered nacre, which throws back a soft sheen whose colour shifts with
// the angle (orient: purple face on, teal and rose toward the rim), a
// faint sky over its top, and one hard, bright highlight where it faces
// the sun. Each band is stepped, as everything else on a herzie is.
vec3 pearly(vec3 color, vec3 n, float shadow) {
  #ifdef MARBLE
  color = marbled(color);
  #endif
  vec3 v = normalize(cameraPosition - vWorldPos);
  vec3 h = normalize(uSun + v);
  float nv = max(dot(n, v), 0.0);
  float nh = max(dot(n, h), 0.0);
  float sunLit = max(dot(n, uSun), 0.0) * shadow;
  // Orient: a cosine palette walked by the view angle, kept muted.
  float t = (1.0 - nv) * 0.9 + 0.62;
  vec3 orient = 0.5 + 0.5 * cos(6.2832 * (t + vec3(0.0, 0.33, 0.67)));
  orient = mix(vec3(0.55, 0.45, 0.85), orient, 0.55);
  float rim = smoothstep(0.35, 0.8, 1.0 - nv);
  color = mix(color, orient * 0.6, rim * 0.45);
  // The sky over its top half.
  float up = reflect(-v, n).y;
  color += vec3(0.07, 0.06, 0.1) * smoothstep(0.1, 0.35, up);
  // A soft glow round the highlight, and the highlight itself.
  float glow = pow(nh, 14.0) * sunLit;
  color += vec3(0.24, 0.18, 0.34) * smoothstep(0.25, 0.6, glow);
  float spec = pow(nh, 90.0) * sunLit;
  color = mix(color, vec3(1.0, 0.98, 1.0), smoothstep(0.35, 0.5, spec));
  return color;
}
#endif

void main() {
  vec3 n = normalize(vWorldNormal);
  #ifdef CLOTH
  // One sheet, both sides drawn: seen from inside, it's the lining.
  bool outside = gl_FrontFacing;
  if (!outside) n = -n;
  bool trim = vUv.y > 1.0 - uHemTrim || vUv.y < uCollarTrim;
  #endif
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
    float t = clamp((vRestY - uTop) / uSpan, 0.0, 0.9999);
    int band = int(floor(t * float(uBands)));
    color = uRamp[band * 3 + shade];
  } else {
    color = uShades[shade];
  }
  #ifdef PATCH
  vec3 coatShade = shade == 2 ? uPatch[2] : shade == 1 ? uPatch[1] : uPatch[0];
  color = mix(color, coatShade, smoothstep(0.4, 0.6, vPatch));
  #endif
  #ifdef CLOTH
  color = trim ? band3(uTrim, shade) : outside ? color : band3(uLining, shade);
  color = clothFinish(color, n, shadow, outside, trim);
  #endif
  #ifdef METAL
  color = polished(color, n, shadow);
  #endif
  #ifdef PEARL
  color = pearly(color, n, shadow);
  #endif
  #ifdef GLOSS
  color = glossy(color, n, shadow);
  #endif
  color *= uLight + uLampColor * lamps;
  color = mix(color, vec3(dot(color, vec3(0.2126, 0.7152, 0.0722))), uGrey);
  color = mix(color, uFlash.rgb, uFlash.w);
  #ifdef GLASS
  // Premultiplied, plus a little of its own colour added on top: a glow,
  // so over something dark it still reads as its colour rather than
  // sinking to the dark behind it. Faded with the herzie, glow and all.
  float glassAlpha = glassy(color, n, shadow) * uOpacity;
  gl_FragColor = vec4(color * (glassAlpha + ${GLASS_GLOW.toFixed(2)} * uOpacity), glassAlpha);
  #else
  gl_FragColor = vec4(color, uOpacity);
  #endif
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
  /** A cloak's cloth (see ClothShading): drawn both sides, its lining
   * inside. */
  cloth?: ClothShading,
  /** A second coat's bands (dim, base, bright), painted where the
   * geometry's `coat` attribute is over a half (the cat's markings). */
  patch?: [string, string, string],
  /** See-through (a translucent skin): drawn blended over its own depth
   * (see glassDepthMaterial), so only its front surface shows. */
  glass = false,
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
  const defines: Record<string, string> = {};
  if (shading.metal) defines.METAL = "";
  if (shading.pearl) defines.PEARL = "";
  if (shading.marble) defines.MARBLE = "";
  if (shading.gloss) defines.GLOSS = "";
  if (glass) defines.GLASS = "";
  if (glass && shading.lens) defines.LENS = "";
  if (cloth) defines.CLOTH = "";
  if (patch) defines.PATCH = "";
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    defines,
    side: cloth ? THREE.DoubleSide : THREE.FrontSide,
    // Glass is blended, over the depth its prepass wrote: it draws only
    // where it's the front surface (LessEqual), and writes no depth itself.
    transparent: glass,
    premultipliedAlpha: glass,
    depthWrite: !glass,
    depthFunc: THREE.LessEqualDepth,
    // Drawn from the side facing the light too: the cloth's thin.
    shadowSide: cloth ? THREE.DoubleSide : null,
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
      // Glass is clear: no stripes or shading pattern painted on it.
      uTexture: { value: shading.textured && !glass ? textureType : 0 },
      uShades: { value: shading.shades.map((hex) => new THREE.Color(hex)) },
      uScheme: { value: painted },
      uBands: { value: painted ? Math.min(ramp.length, MAX_BANDS) : 1 },
      uRamp: { value: rampColors },
      // Shared by reference: the herzie updates them once for all its parts.
      uTop: scheme.uTop,
      uSpan: scheme.uSpan,
      uRestY: { value: new THREE.Vector4(0, 1, 0, 0) },
      uGrey: scheme.uGrey,
      uOpacity: scheme.uOpacity,
      uFlash: scheme.uFlash,
      uRadius: { value: metalRadius },
      ...(patch && {
        uPatch: { value: patch.map((hex) => new THREE.Color(hex)) },
      }),
      ...(cloth && {
        uLining: { value: cloth.lining.map((hex) => new THREE.Color(hex)) },
        uTrim: { value: cloth.trim.map((hex) => new THREE.Color(hex)) },
        uFinish: { value: cloth.finish },
        uHemTrim: { value: cloth.hemTrim },
        uCollarTrim: { value: cloth.collarTrim },
      }),
    },
  });
  return material;
}

/** Glass draws last: its depth prepass, then its colour, both after the
 * rest of the transparent queue (renderOrder 0: water, clouds, particles),
 * so everything behind a see-through herzie is there to show through it —
 * drawn before the prepass, a puddle behind it would be cut out in its
 * shape. */
export const GLASS_PREPASS_ORDER = 10;
/** A see-through herzie's solid parts (eyes, anything worn): after the
 * prepass, so whatever of them is inside or behind the glass body (the
 * half of a cap's crown inside the head, most of an eye) is cut off at its
 * surface, as on a solid herzie. */
export const GLASS_SOLID_ORDER = 11;
export const GLASS_ORDER = 12;

/**
 * Glass's depth prepass: its shape, depth only, no colour. A see-through
 * herzie is many overlapping parts; blended as they are, each would show
 * through the others (an arm through the body, the far side of the head).
 * Drawn first into the depth buffer, the parts leave only the nearest
 * surface for the glass to draw on: one clean shell. Pushed a hair back
 * (polygon offset), so the glass on that same surface still passes.
 */
export function glassDepthMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    colorWrite: false,
    // In the transparent queue, so it can come after its other members.
    transparent: true,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

/**
 * What glass casts into the sun's shadow map: its shape, with every other
 * texel of the map left out (a checkerboard), so the shadow it throws comes
 * out about half as dark once the map's filtering softens it: light gets
 * through glass. The screen-door trick, in the shadow only.
 */
export function glassShadowMaterial(): THREE.MeshDepthMaterial {
  const material = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      `void main() {
  if (mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0) < 0.5) discard;`,
    );
  };
  return material;
}

/** A cloak's cloth, besides its outside's bands: its lining's and trim's
 * bands (dim, base, bright), its finish (CLOTH_FINISH), and how deep its
 * trim runs at the hem and the collar (fractions of its length). */
export type ClothShading = {
  lining: [string, string, string];
  trim: [string, string, string];
  finish: number;
  hemTrim: number;
  collarTrim: number;
};

/**
 * Where a part sits at rest in creature space, for its scheme's bands (see
 * `uRestY`): taken from its matrix now, as built, and set on its material
 * just before it's drawn (the parts share materials).
 */
export function setRestPlace(mesh: THREE.Mesh): void {
  mesh.updateMatrix();
  const e = mesh.matrix.elements;
  const row = new THREE.Vector4(e[1], e[5], e[9], e[13]);
  mesh.onBeforeRender = (_r, _s, _c, _g, material) => {
    const m = material as THREE.ShaderMaterial;
    const u = m.uniforms?.uRestY;
    if (!u) return;
    (u.value as THREE.Vector4).copy(row);
    m.uniformsNeedUpdate = true;
  };
}
