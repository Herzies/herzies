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
// - Tone mapping kept in the shaders while the ambient occlusion pass
//   (Occlusion) draws the scene off-screen: three only tone-maps what it
//   draws straight to the screen, and doing it after, in the composer,
//   would tone-map the fog and the sky too, which three never does.
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
 * The Town's own look, as a uniform every built-in material shares: xy the
 * cloud shadows' drift, z 1 to tone-map in the shader regardless (see
 * Occlusion), w the cloud shadows' strength. All 0 by default, so a scene
 * that isn't the Town is untouched. A plain object, not a THREE.Vector4:
 * three clones those per material, but hands plain values on by reference.
 */
export const townLook = { x: 0, y: 0, z: 0, w: 0 };

/** Moves the cloud shadows downwind to where they are at `time`. */
export function driftClouds(time: number, wind: THREE.Vector2) {
  const wrap = CLOUD_CELL * CLOUD_PERIOD;
  const travel = (time * CLOUD_SPEED) % wrap;
  // The pattern moves downwind: sample upwind of each point.
  townLook.x = -wind.x * travel;
  townLook.y = -wind.y * travel;
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
  let out = replaceExactly(
    chunk,
    "float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );",
    `float fogFactor = smoothstep( ${FAR_FROM.toFixed(1)}, ${FAR_TO.toFixed(1)}, vFogDepth );
		float haze = fogFar * ${HAZE_MAX} * ( 1.0 - exp( - max( 0.0, vFogDepth - fogNear ) / ${HAZE_REACH.toFixed(1)} ) );
		float mist = ${MIST_MAX} * smoothstep( ${MIST_FROM.toFixed(1)}, ${MIST_TO.toFixed(1)}, vFogHeight );
		fogFactor = 1.0 - ( 1.0 - fogFactor ) * ( 1.0 - haze ) * ( 1.0 - mist );`,
    1,
  );
  // Off-screen (see Occlusion) the colour and the fog's are both still
  // linear here; on screen three has already encoded both to sRGB, and
  // mixes them there. Mix the same way either way, or the haze comes out
  // far thicker.
  out = replaceExactly(
    out,
    "gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );",
    `if ( townLook.z > 0.5 ) {
		vec3 fogOnScreen = sRGBTransferOETF( vec4( fogColor, 1.0 ) ).rgb;
		gl_FragColor.rgb = sRGBTransferEOTF( vec4( mix( sRGBTransferOETF( gl_FragColor ).rgb, fogOnScreen, fogFactor ), 1.0 ) ).rgb;
	} else {
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
	}`,
    1,
  );
  return out;
}

export function lightsParsChunk(chunk: string): string {
  return `${chunk}
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
	if ( townLook.w <= 0.0 ) return 1.0;
	vec2 p = ( ${worldFromView("viewPosition")}.xz + townLook.xy ) / ${CLOUD_CELL.toFixed(1)};
	float n = 0.65 * townCloudNoise( p ) + 0.35 * townCloudNoise( p * 2.0 + 37.0 );
	return 1.0 - townLook.w * smoothstep( 0.5, 0.66, n );
}`;
}

/** Declares the shared uniform, and three's ACES curve (at exposure 1) for
 * when three itself leaves tone mapping out. */
export function commonChunk(chunk: string): string {
  return `${chunk}
uniform vec4 townLook;
vec3 townACESFilmic( vec3 color ) {
	// three's ACESFilmicToneMapping (tonemapping_pars_fragment).
	const mat3 inputMat = mat3(
		vec3( 0.59719, 0.07600, 0.02840 ),
		vec3( 0.35458, 0.90834, 0.13383 ),
		vec3( 0.04823, 0.01566, 0.83777 )
	);
	const mat3 outputMat = mat3(
		vec3(  1.60475, -0.10208, -0.00327 ),
		vec3( -0.53108,  1.10813, -0.07276 ),
		vec3( -0.07367, -0.00605,  1.07602 )
	);
	color = inputMat * ( color / 0.6 );
	vec3 a = color * ( color + 0.0245786 ) - 0.000090537;
	vec3 b = color * ( 0.983729 * color + 0.4329510 ) + 0.238081;
	return clamp( outputMat * ( a / b ), 0.0, 1.0 );
}`;
}

export function toneMappingChunk(chunk: string): string {
  return replaceExactly(
    chunk,
    "gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );",
    `gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
#else
	if ( townLook.z > 0.5 ) gl_FragColor.rgb = townACESFilmic( gl_FragColor.rgb );`,
    1,
  );
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
  chunks.common = MARK + commonChunk(chunks.common);
  chunks.tonemapping_fragment =
    MARK + toneMappingChunk(chunks.tonemapping_fragment);
  chunks.fog_pars_vertex = MARK + fogParsVertexChunk(chunks.fog_pars_vertex);
  chunks.fog_vertex = MARK + fogVertexChunk(chunks.fog_vertex);
  chunks.fog_pars_fragment =
    MARK + fogParsFragmentChunk(chunks.fog_pars_fragment);
  chunks.fog_fragment = MARK + fogFragmentChunk(chunks.fog_fragment);
  chunks.lights_pars_begin = MARK + lightsParsChunk(chunks.lights_pars_begin);
  chunks.lights_fragment_begin =
    MARK + lightsFragmentChunk(chunks.lights_fragment_begin);
}
// Every built-in material shares the Town's look (see `townLook`), and so
// does every shader material made with three's fog uniforms (the herzies).
for (const shader of Object.values(THREE.ShaderLib)) {
  shader.uniforms.townLook = { value: townLook };
}
(THREE.UniformsLib.fog as Record<string, THREE.IUniform>).townLook = {
  value: townLook,
};
