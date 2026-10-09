import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { SHADOW_TAPS } from "./shadows";

describe("smooth shadows", () => {
  it("samples three's shadows still and densely", () => {
    const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
    // No per-pixel noise turning the pattern…
    expect(chunk).not.toContain("interleavedGradientNoise( gl_FragCoord.xy )");
    expect(chunk).not.toContain("vogelDiskSample( 0, 5, phi )");
    // …and more samples, for directional/spot lights and for point lights.
    expect(
      chunk.split(`vogelDiskSample( i, ${SHADOW_TAPS}, phi )`).length - 1,
    ).toBe(2);
  });
});
