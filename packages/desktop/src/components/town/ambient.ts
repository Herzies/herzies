import { noLamps } from "@herzies/shared/gl";
import * as THREE from "three";
import { dayOfYear, type SeasonLook, seasonLook } from "./Seasons";

/**
 * What the world's moving parts share, as shader uniforms: the time, where
 * the player is, which way the wind blows, and how dark it is. One object,
 * shared by reference with every material that uses it, and updated once a
 * frame by <AmbientClock> (TownCanvas).
 */
export const ambient = {
  uTime: { value: 0 },
  uPlayer: { value: new THREE.Vector3() },
  uWindDir: { value: new THREE.Vector2(0.8, 0.6).normalize() },
  /** 0 by day, 1 at night (see DayCycle). */
  uNight: { value: 0 },
  /** How herzies are lit: their own shader ignores the scene's lights, so
   * the day cycle tints them through this. */
  uLight: { value: new THREE.Color(1, 1, 1) },
  /** Where herzies are lit from: the sun (or moon), held to a mid height
   * (see skyLights). */
  uSun: { value: new THREE.Vector3(-10, 20, 8).normalize() },
  /** The player's chest, in view space (camera at the origin): what the
   * camera looks at, for see-through occluders (set by CameraRig). */
  uPlayerView: { value: new THREE.Vector3(0, 0, -12) },
  /** The lamp posts and lit windows near enough to light herzies, and
   * their colour (see NightLights). */
  uLamps: { value: noLamps() },
  uLampColor: { value: new THREE.Color("#ffc47a") },
  /** The time of year (see Seasons.ts, set by DayLight): the greens'
   * tints, how far the oaks have turned and dropped their leaves, the
   * blossom, and the snow lying on what faces up. */
  uGrassTint: { value: new THREE.Color(1, 1, 1) },
  uLeafTint: { value: new THREE.Color(1, 1, 1) },
  uNeedleTint: { value: new THREE.Color(1, 1, 1) },
  uFall: { value: 0 },
  uBare: { value: 0 },
  uBlossom: { value: 0 },
  uSnow: { value: 0 },
  uIce: { value: 0 },
};

/** The time of year as it's shown, for what moves on the CPU (the
 * particles): set by DayLight alongside the uniforms above. */
export const seasonNow: { look: SeasonLook } = {
  look: seasonLook(dayOfYear()),
};

/** The gust's swell at a spot, 0.1–1, as the wind shaders work it out
 * (the slow swell rolling downwind in `swayInWind`): for what moves on
 * the CPU and should lean with the trees round it. */
export function gustAt(x: number, z: number, t: number): number {
  const w = ambient.uWindDir.value;
  const along = x * w.x + z * w.y;
  return 0.55 + 0.45 * Math.sin(along * 0.07 - t * 0.45);
}

/** How a material moves in the wind. */
export type Sway = {
  /** Sideways give per unit of height above `from`. */
  amount: number;
  /** World height where swaying starts (below it, nothing moves). */
  from: number;
  /** How far it leans away from the player walking through it (0: not
   * at all). */
  bend?: number;
  /** How far leaves flutter: a quick shimmer, each spot its own (0: none). */
  flutter?: number;
};

/**
 * Make a (Lambert, possibly instanced) material sway in the wind: gusts
 * that roll across the island, more the higher up a vertex is, so roots
 * stay planted — and, with `bend`, part around the player. Patched into
 * three's own shader, so lighting, fog and instancing are untouched.
 */
export function swayInWind<M extends THREE.Material>(
  material: M,
  sway: Sway,
): M {
  const own = {
    uSway: { value: sway.amount },
    uSwayFrom: { value: sway.from },
    uBend: { value: sway.bend ?? 0 },
    uFlutter: { value: sway.flutter ?? 0 },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, ambient, own);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
uniform float uTime;
uniform vec3 uPlayer;
uniform vec2 uWindDir;
uniform float uSway;
uniform float uSwayFrom;
uniform float uBend;
uniform float uFlutter;`,
      )
      .replace(
        "#include <project_vertex>",
        /* glsl */ `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
vec4 worldPos = modelMatrix * mvPosition;
float above = max( 0.0, worldPos.y - uSwayFrom );
// Gusts: a ripple rolling downwind, under a slow swell, so the wind comes
// and goes across the island rather than everything nodding in time.
float along = dot( worldPos.xz, uWindDir );
float swell = 0.55 + 0.45 * sin( along * 0.07 - uTime * 0.45 );
float wave = sin( along * 0.35 - uTime * 1.7 ) + 0.35 * sin( along * 0.9 + worldPos.x * 0.3 - uTime * 2.9 );
vec2 lean = uWindDir * wave * swell;
// Parting around the player.
vec2 away = worldPos.xz - uPlayer.xz;
float dist = length( away );
float push = uBend * smoothstep( 1.5, 0.3, dist );
lean += push * away / max( dist, 0.001 ) * 2.5;
worldPos.xz += lean * above * uSway;
worldPos.y -= push * above * 0.35;
// Leaves fluttering: quick and small, out of step from spot to spot (the
// same at the same spot, so faces sharing a corner stay joined).
if ( uFlutter > 0.0 && above > 0.0 ) {
  float phase = dot( worldPos.xyz, vec3( 1.7, 2.3, 1.3 ) );
  worldPos.xyz += uFlutter * swell * vec3(
    sin( uTime * 4.1 + phase ),
    0.6 * sin( uTime * 5.3 + phase * 1.3 ),
    sin( uTime * 3.7 + phase * 0.7 )
  );
}
mvPosition = viewMatrix * worldPos;
gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  material.customProgramCacheKey = () =>
    `sway:${sway.amount}:${sway.from}:${sway.bend ?? 0}:${sway.flutter ?? 0}`;
  return material;
}

/**
 * Let the player be seen through a material: wherever it comes between
 * the camera and the player's herzie, only a scattered few of its
 * pixels are drawn (a screen-door dither, crisp like the rest of the
 * pixelated Town, and with no sorting to get wrong) — so a tree or a
 * house in the way is just visible, rather than the camera diving in
 * front of it. Fades in smoothly round the line of sight. Works on
 * Lambert materials, instanced or not, and on top of `swayInWind`.
 */
export function seeThrough<M extends THREE.Material>(material: M): M {
  const before = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.uniforms.uPlayerView = ambient.uPlayerView;
    // Its own view-space position (not every material has one), taken
    // once the vertex is placed — after any swaying.
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
varying vec3 vSeeView;`,
      )
      .replace(
        "#include <fog_vertex>",
        /* glsl */ `#include <fog_vertex>
vSeeView = mvPosition.xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
uniform vec3 uPlayerView;
varying vec3 vSeeView;`,
      )
      .replace(
        "#include <clipping_planes_fragment>",
        /* glsl */ `#include <clipping_planes_fragment>
{
  // This fragment, and the player, as seen from the camera.
  vec3 here = vSeeView;
  float along = dot( here, normalize( uPlayerView ) );
  float toPlayer = length( uPlayerView );
  // Only what's in front of the player (with a little room for the
  // herzie's own width)…
  float inFront = smoothstep( toPlayer - 0.6, toPlayer - 1.6, along ) * step( 0.0, along );
  // …and near the line of sight.
  float off = length( here - normalize( uPlayerView ) * along );
  float near = smoothstep( 3.2, 1.8, off );
  float hide = inFront * near;
  if ( hide > 0.0 ) {
    // A 4×4 ordered dither: keep fewer pixels the more it's in the way.
    ivec2 cell = ivec2( mod( gl_FragCoord.xy, 4.0 ) );
    int i = cell.x + cell.y * 4;
    float bayer[16] = float[16]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
    if ( ( bayer[i] + 0.5 ) / 16.0 < hide * 0.82 ) discard;
  }
}`,
      );
  };
  material.customProgramCacheKey = () => `${key()}:seeThrough`;
  return material;
}

/**
 * Light a (Lambert) material in steps: the sun's light comes in two or
 * three flat bands — shadow, lit, full sun — rather than a smooth ramp,
 * so a rounded crown reads as a few bold shapes at the Town's big pixels.
 */
export function banded<M extends THREE.Material>(material: M): M {
  const before = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <lights_lambert_pars_fragment>",
      THREE.ShaderChunk.lights_lambert_pars_fragment.replace(
        "float dotNL = saturate( dot( geometryNormal, directLight.direction ) );",
        /* glsl */ `float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
dotNL = 0.12 + 0.5 * smoothstep( 0.08, 0.14, dotNL ) + 0.38 * smoothstep( 0.55, 0.61, dotNL );`,
      ),
    );
  };
  material.customProgramCacheKey = () => `${key()}:banded`;
  return material;
}

/** Which tint a material's greens take with the seasons: the ground's
 * grass, the leaves that turn (bushes, tall grass), the pines' needles,
 * or an oak's crown (which also turns, drops its leaves and blossoms). */
export type Foliage = "grass" | "leaf" | "needles" | "oak";

/**
 * Let the seasons show on a material: its greens tinted for the time of
 * year — told apart from the rest of its colours by being green, so bark,
 * stone and gravel stay as they are — and snow lying on whatever faces
 * up. An oak's crown goes red and gold tree by tree in fall, thins to bare
 * branches in winter and blossoms in spring. Chained onto whatever the
 * material already patches (swaying, see-through), like `seeThrough`.
 */
export function inSeason<M extends THREE.Material>(
  material: M,
  foliage?: Foliage,
  /** The ground: what isn't grass (the paths) is trodden, only dusted. */
  trodden = false,
): M {
  const before = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey.bind(material);
  const tint = {
    grass: "uGrassTint",
    leaf: "uLeafTint",
    needles: "uNeedleTint",
    oak: "uLeafTint",
  } as const;
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    Object.assign(shader.uniforms, {
      uGrassTint: ambient.uGrassTint,
      uLeafTint: ambient.uLeafTint,
      uNeedleTint: ambient.uNeedleTint,
      uFall: ambient.uFall,
      uBare: ambient.uBare,
      uBlossom: ambient.uBlossom,
      uSnow: ambient.uSnow,
    });
    // Its world position, once the vertex is placed (after any swaying),
    // and for an instanced oak, which tree it is.
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
varying vec3 vSeasonWorld;
varying float vSeasonTree;
varying float vSeasonLump;
${foliage === "oak" ? "attribute float lump;" : ""}`,
      )
      .replace(
        "#include <fog_vertex>",
        /* glsl */ `#include <fog_vertex>
vSeasonWorld = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz + cameraPosition;
vSeasonLump = ${foliage === "oak" ? "lump" : "0.5"};
#ifdef USE_INSTANCING
  vSeasonTree = fract( sin( dot( instanceMatrix[3].xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
#else
  vSeasonTree = 0.5;
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
uniform vec3 uGrassTint;
uniform vec3 uLeafTint;
uniform vec3 uNeedleTint;
uniform float uFall;
uniform float uBare;
uniform float uBlossom;
uniform float uSnow;
varying vec3 vSeasonWorld;
varying float vSeasonTree;
varying float vSeasonLump;
float seasonHash( vec3 p ) {
  return fract( sin( dot( p, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
}
// Smooth value noise over the ground, 0–1: where snow drifts and thins.
float seasonNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = seasonHash( vec3( i, 0.0 ) );
  float b = seasonHash( vec3( i + vec2( 1.0, 0.0 ), 0.0 ) );
  float c = seasonHash( vec3( i + vec2( 0.0, 1.0 ), 0.0 ) );
  float d = seasonHash( vec3( i + vec2( 1.0, 1.0 ), 0.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}`,
      )
      .replace(
        "#include <alphamap_fragment>",
        /* glsl */ `{
  vec3 c = diffuseColor.rgb;
  // How green this is: the plants, not their bark or the stone.
  float green = smoothstep( 0.005, 0.04, c.g - max( c.r, c.b ) );
  vec3 tinted = c * ${foliage ? tint[foliage] : "vec3( 1.0 )"};
${
  foliage === "oak"
    ? /* glsl */ `  // Each tree in its turn (the same turn every year, see oakShadow):
  // bare in winter, its whole crown gone at once, leaving the branches;
  // and in spring back in leaf the same day it flowers.
  float turn = vSeasonTree * 0.98 + 0.01;
  if ( green > 0.5 && 1.0 - turn < uBare ) discard;
  // Fall: each tree its own red, orange or gold, as bright as its green.
  float shade = clamp( c.g * 2.6, 0.22, 1.1 );
  vec3 red = vec3( 0.6, 0.04, 0.01 );
  vec3 orange = vec3( 0.95, 0.24, 0.01 );
  vec3 gold = vec3( 0.92, 0.55, 0.01 );
  float pick = fract( vSeasonTree + vSeasonLump * 0.3 );
  vec3 turned = pick < 0.5 ? mix( red, orange, pick * 2.0 ) : mix( orange, gold, pick * 2.0 - 1.0 );
  tinted = mix( tinted, turned * shade, uFall * smoothstep( 0.15, 0.6, vSeasonTree + uFall * 0.6 ) );
  // Spring: a cherry in full blossom, all of it — no green — shaded
  // dark pink underneath to pale on top. Each tree comes into leaf on its
  // own day as the blossom's season ends, all at once, not bit by bit.
  float inFlower = step( turn, uBlossom );
  vec3 petal = mix( vec3( 0.42, 0.13, 0.24 ), vec3( 0.98, 0.7, 0.8 ), smoothstep( 0.25, 1.05, shade ) );
  // A clump here and there paler, nearly white.
  petal = mix( petal, petal * 0.35 + vec3( 0.62, 0.55, 0.58 ), step( 0.75, fract( vSeasonLump * 7.3 + vSeasonTree * 3.1 ) ) * 0.6 );
  tinted = mix( tinted, petal, inFlower );`
    : ""
}
  diffuseColor.rgb = mix( c, tinted, green );
  // Snow on what faces up: the face's own normal, from the slope of its
  // world position across the screen, turned to face the camera.
  vec3 n = normalize( cross( dFdx( vSeasonWorld ), dFdy( vSeasonWorld ) ) );
  if ( dot( n, cameraPosition - vSeasonWorld ) < 0.0 ) n = -n;
  float lies = smoothstep( 0.45, 0.8, n.y );
  // Patchy as it comes and goes: drifts and thin spots, crisp-edged.
  vec2 xz = vSeasonWorld.xz;
  float drift = seasonNoise( xz * 0.8 ) * 0.65 + seasonNoise( xz * 2.6 ) * 0.35;
  float grain = seasonHash( floor( vSeasonWorld * 5.0 ) );
  float depth = uSnow * lies * ${trodden ? "mix( 0.55, 1.15, green )" : "1.15"};
  float cover = step( 1.0 - depth, drift );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.7, 0.75, 0.84 ) * ( 0.94 + grain * 0.06 ), cover );
}
#include <alphamap_fragment>`,
      );
  };
  material.customProgramCacheKey = () =>
    `${key()}:season:${foliage ?? "none"}:${trodden}`;
  return material;
}
