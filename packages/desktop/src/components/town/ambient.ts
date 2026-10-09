import * as THREE from "three";

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
  /** The player's chest, in view space (camera at the origin): what the
   * camera looks at, for see-through occluders (set by CameraRig). */
  uPlayerView: { value: new THREE.Vector3(0, 0, -12) },
};

/** How a material moves in the wind. */
export type Sway = {
  /** Sideways give per unit of height above `from`. */
  amount: number;
  /** World height where swaying starts (below it, nothing moves). */
  from: number;
  /** How far it leans away from the player walking through it (0: not
   * at all). */
  bend?: number;
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
uniform float uBend;`,
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
mvPosition = viewMatrix * worldPos;
gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  material.customProgramCacheKey = () =>
    `sway:${sway.amount}:${sway.from}:${sway.bend ?? 0}`;
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
