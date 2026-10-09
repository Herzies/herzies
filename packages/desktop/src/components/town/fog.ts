import * as THREE from "three";
import { replaceExactly } from "./shadows";

// Depth by day. At night the lamps' pools of light say what's near and
// what's far; by day nothing did. Patched into three's shader source once,
// before anything compiles, so every lit and fogged material (herzies
// included) gets it with no extra pass:
//
// - Haze (aerial perspective): from just past the player, things fade
//   towards the horizon colour the further off they are — never all the
//   way, so the distant islands stay pale shapes rather than vanishing.
// - Mist below: the islands' undersides fade into the sky beneath them.
// - Cloud shadows: soft patches of shade drifting across the island with
//   the wind, on the sun's light only.
//
// The haze rides on the scene's THREE.Fog, whose `near` and `far` three
// already hands every fogged material each frame: `near` is where the
// haze starts, and `far` — reused — how thick it is (0–1; see
// DayCycle's `haze`). The old far-off fade stays underneath, unchanged.

/** Where the haze starts, in view depth: a little short of the player
 * (the camera is 12 behind), so the herzie you're playing stays clear. */
export const HAZE_START = 10;
/** How quickly the haze builds past HAZE_START (the distance over which
 * it reaches ~63% of HAZE_MAX). */
const HAZE_REACH = 70;
/** The most the haze ever covers, however far off. */
const HAZE_MAX = 0.85;
/** The far-off fade, as it was before there was haze. */
const FAR_FROM = 40;
const FAR_TO = 260;
/** The mist below: none above MIST_FROM, MIST_MAX by MIST_TO (world y;
 * the home island's grass is at 0, its underside tip ~32 below). */
const MIST_FROM = -3;
const MIST_TO = -36;
const MIST_MAX = 0.75;
/** How big the cloud shadows' noise cells are, in world units. */
const CLOUD_CELL = 14;
/** The noise repeats every this many cells: the drift wraps by exactly
 * that much, so it never pops (see driftClouds). */
const CLOUD_PERIOD = 256;
/** How fast the cloud shadows drift, in world units a second (about the
 * sky's own clouds, see Clouds). */
const CLOUD_SPEED = 0.8;
/** How much of the sun a cloud takes away, at full day. */
export const CLOUD_SHADE = 0.4;

/**
 * The cloud shadows' state, as a uniform every lit material shares: xy
 * the drift, w the strength (0: none — the default, so a scene that
 * isn't the Town is untouched). A plain object, not a THREE.Vector4: three
 * clones those per material, but hands plain values on by reference.
 */
export const cloudShadows = { x: 0, y: 0, z: 0, w: 0 };

/** Moves the cloud shadows downwind to where they are at `time`. */
export function driftClouds(time: number, wind: THREE.Vector2) {
  const wrap = CLOUD_CELL * CLOUD_PERIOD;
  const travel = (time * CLOUD_SPEED) % wrap;
  // The pattern moves downwind: sample upwind of each point.
  cloudShadows.x = -wind.x * travel;
  cloudShadows.y = -wind.y * travel;
}

/** A world position from a view-space one (the view matrix is a rotation
 * and a shift, so its inverse is the transposed rotation). */
const WORLD_FROM_VIEW = /* glsl */ `( transpose( mat3( viewMatrix ) ) * ( VIEW - viewMatrix[ 3 ].xyz ) )`;
const worldFromView = (view: string) => WORLD_FROM_VIEW.replace("VIEW", view);

export function fogParsVertexChunk(chunk: string): string {
  return replaceExactly(
    chunk,
    "varying float vFogDepth;",
    `varying float vFogDepth;
	varying float vFogHeight;`,
    1,
  );
}

export function fogVertexChunk(chunk: string): string {
  return replaceExactly(
    chunk,
    "vFogDepth = - mvPosition.z;",
    `vFogDepth = - mvPosition.z;
	vFogHeight = ${worldFromView("mvPosition.xyz")}.y;`,
    1,
  );
}

export function fogParsFragmentChunk(chunk: string): string {
  return replaceExactly(
    chunk,
    "varying float vFogDepth;",
    `varying float vFogDepth;
	varying float vFogHeight;`,
    1,
  );
}

export function fogFragmentChunk(chunk: string): string {
  return replaceExactly(
    chunk,
    "float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );",
    `float fogFactor = smoothstep( ${FAR_FROM.toFixed(1)}, ${FAR_TO.toFixed(1)}, vFogDepth );
		float haze = fogFar * ${HAZE_MAX} * ( 1.0 - exp( - max( 0.0, vFogDepth - fogNear ) / ${HAZE_REACH.toFixed(1)} ) );
		float mist = ${MIST_MAX} * smoothstep( ${MIST_FROM.toFixed(1)}, ${MIST_TO.toFixed(1)}, vFogHeight );
		fogFactor = 1.0 - ( 1.0 - fogFactor ) * ( 1.0 - haze ) * ( 1.0 - mist );`,
    1,
  );
}

export function lightsParsChunk(chunk: string): string {
  return `${chunk}
uniform vec4 townClouds;
// Value noise that repeats every ${CLOUD_PERIOD} cells.
float townCloudHash( ivec2 c ) {
	uvec2 q = uvec2( c & ${CLOUD_PERIOD - 1} );
	uint h = q.x * 1597334677u ^ q.y * 3812015801u;
	h = ( h ^ ( h >> 16u ) ) * 0x45d9f3bu;
	h ^= h >> 16u;
	return float( h ) / 4294967295.0;
}
float townCloudNoise( vec2 p ) {
	ivec2 i = ivec2( floor( p ) );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	return mix(
		mix( townCloudHash( i ), townCloudHash( i + ivec2( 1, 0 ) ), u.x ),
		mix( townCloudHash( i + ivec2( 0, 1 ) ), townCloudHash( i + ivec2( 1, 1 ) ), u.x ),
		u.y );
}
// How much of the sun gets through the clouds at a (view-space) point.
float townCloudLight( vec3 viewPosition ) {
	if ( townClouds.w <= 0.0 ) return 1.0;
	vec2 p = ( ${worldFromView("viewPosition")}.xz + townClouds.xy ) / ${CLOUD_CELL.toFixed(1)};
	float n = 0.65 * townCloudNoise( p ) + 0.35 * townCloudNoise( p * 2.0 + 37.0 );
	return 1.0 - townClouds.w * smoothstep( 0.5, 0.66, n );
}`;
}

export function lightsFragmentChunk(chunk: string): string {
  return replaceExactly(
    chunk,
    "getDirectionalLightInfo( directionalLight, directLight );",
    `getDirectionalLightInfo( directionalLight, directLight );
		directLight.color *= townCloudLight( geometryPosition );`,
    1,
  );
}

const MARK = "// town: depth\n";
const chunks = THREE.ShaderChunk as Record<string, string>;
// Once (a hot reload runs this again).
if (!chunks.fog_fragment.startsWith(MARK)) {
  chunks.fog_pars_vertex = MARK + fogParsVertexChunk(chunks.fog_pars_vertex);
  chunks.fog_vertex = MARK + fogVertexChunk(chunks.fog_vertex);
  chunks.fog_pars_fragment =
    MARK + fogParsFragmentChunk(chunks.fog_pars_fragment);
  chunks.fog_fragment = MARK + fogFragmentChunk(chunks.fog_fragment);
  chunks.lights_pars_begin = MARK + lightsParsChunk(chunks.lights_pars_begin);
  chunks.lights_fragment_begin =
    MARK + lightsFragmentChunk(chunks.lights_fragment_begin);
}
// Every lit material shares the cloud shadows (see `cloudShadows`).
for (const shader of Object.values(THREE.ShaderLib)) {
  if ("directionalLights" in shader.uniforms) {
    shader.uniforms.townClouds = { value: cloudShadows };
  }
}
