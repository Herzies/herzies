import * as THREE from "three";

// Smooth shadows. three's soft shadows (PCF) take five samples round each
// point, the pattern turned a different way at every pixel (interleaved
// gradient noise) — meant to be blurred away by a TAA pass. The Town has
// none, and draws chunky pixels besides, so the noise shows as a speckled
// checker along every shadow's edge. Here the pattern holds still and takes
// more samples instead: a smooth edge, the same from frame to frame.
// Patched into three's shader source once, before anything compiles.

/** Samples per shadow lookup (each a hardware 2×2 filtered tap). */
export const SHADOW_TAPS = 12;

/** Replace `find` in `source`, insisting it's there exactly `count` times:
 * a three upgrade that moves things round fails loudly, not silently. */
export function replaceExactly(
  source: string,
  find: string | RegExp,
  replace: string,
  count: number,
): string {
  const re =
    typeof find === "string"
      ? new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
      : new RegExp(find.source, "g");
  const found = source.match(re)?.length ?? 0;
  if (found !== count) {
    throw new Error(
      `town shadows: expected ${count} of ${re} in three's shadow shader, found ${found}`,
    );
  }
  return source.replace(re, () => replace);
}

/** three's shadow-map fragment chunk, with still, denser sampling. */
export function smoothShadowChunk(chunk: string): string {
  let out = replaceExactly(
    chunk,
    "float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;",
    "float phi = 0.0;",
    2,
  );
  // Directional and spot lights: the five-tap sum, as a loop.
  out = replaceExactly(
    out,
    /shadow = \(\s*texture\( shadowMap, vec3\( shadowCoord\.xy \+ vogelDiskSample\( 0, 5, phi \)[\s\S]*?\) \* 0\.2;/,
    `shadow = 0.0;
				for ( int i = 0; i < ${SHADOW_TAPS}; i ++ ) {
					shadow += texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( i, ${SHADOW_TAPS}, phi ) * radius, shadowCoord.z ) );
				}
				shadow /= ${SHADOW_TAPS}.0;`,
    1,
  );
  // Point lights (the lamp posts): the same, round the cube.
  out = replaceExactly(
    out,
    /vec2 sample0 = vogelDiskSample\( 0, 5, phi \);[\s\S]*?\) \* 0\.2;/,
    `shadow = 0.0;
			for ( int i = 0; i < ${SHADOW_TAPS}; i ++ ) {
				vec2 s = vogelDiskSample( i, ${SHADOW_TAPS}, phi );
				shadow += texture( shadowMap, vec4( bd3D + ( tangent * s.x + bitangent * s.y ) * texelSize, dp ) );
			}
			shadow /= ${SHADOW_TAPS}.0;`,
    1,
  );
  return out;
}

const MARK = "// town: smooth shadows\n";
const chunks = THREE.ShaderChunk as Record<string, string>;
// Once (a hot reload runs this again).
if (!chunks.shadowmap_pars_fragment.startsWith(MARK)) {
  chunks.shadowmap_pars_fragment =
    MARK + smoothShadowChunk(chunks.shadowmap_pars_fragment);
}
