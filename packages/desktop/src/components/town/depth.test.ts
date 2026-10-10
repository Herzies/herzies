import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { driftClouds, townLook } from "./depth";

describe("daytime depth", () => {
  it("adds haze and mist to three's fog", () => {
    const chunks = THREE.ShaderChunk;
    expect(chunks.fog_vertex).toContain("vFogHeight =");
    expect(chunks.fog_pars_vertex).toContain("varying float vFogHeight;");
    expect(chunks.fog_pars_fragment).toContain("varying float vFogHeight;");
    expect(chunks.fog_fragment).toContain("float haze = fogFar");
    expect(chunks.fog_fragment).toContain("float mist =");
  });

  it("shades the sun's light, and only it, under clouds", () => {
    expect(THREE.ShaderChunk.lights_pars_begin).toContain(
      "float townCloudLight(",
    );
    expect(
      THREE.ShaderChunk.lights_fragment_begin.split("townCloudLight(").length -
        1,
    ).toBe(1);
  });

  it("shares one uniform with every built-in material", () => {
    const lambert = THREE.UniformsUtils.clone(THREE.ShaderLib.lambert.uniforms);
    const standard = THREE.UniformsUtils.clone(
      THREE.ShaderLib.standard.uniforms,
    );
    const basic = THREE.UniformsUtils.clone(THREE.ShaderLib.basic.uniforms);
    expect(lambert.townLook.value).toBe(townLook);
    expect(standard.townLook.value).toBe(townLook);
    expect(basic.townLook.value).toBe(townLook);
    // The herzies' shader material is built on three's fog uniforms.
    const fog = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
    expect((fog as Record<string, THREE.IUniform>).townLook.value).toBe(
      townLook,
    );
  });

  it("can tone-map in the shader when three leaves it out", () => {
    expect(THREE.ShaderChunk.common).toContain("uniform vec4 townLook;");
    expect(THREE.ShaderChunk.tonemapping_fragment).toContain(
      "townACESFilmic( gl_FragColor.rgb )",
    );
  });

  it("drifts the clouds downwind, wrapping without a jump", () => {
    const wind = new THREE.Vector2(0.8, 0.6);
    const wrap = 14 * 256;
    // A step, modulo the noise's period: a wrap is exactly one period, so
    // it disappears here, and anything else shows.
    const moved = (d: number) => (((d % wrap) + wrap * 1.5) % wrap) - wrap / 2;
    // Steady drift on each axis at any moment, including across x's first
    // wrap (3584 / (0.8 * 0.8) = 5600 s) and y's (~7466.7 s) — and 4480 s,
    // where wrapping the distance travelled, not each axis, jumped.
    for (const t of [10, 4479.9, 5599.9, 7466.6, 1e6 + 0.3]) {
      driftClouds(t, wind);
      const a = { ...townLook };
      driftClouds(t + 0.5, wind);
      expect(moved(townLook.x - a.x)).toBeCloseTo(-0.8 * 0.8 * 0.5, 6);
      expect(moved(townLook.y - a.y)).toBeCloseTo(-0.6 * 0.8 * 0.5, 6);
      expect(Math.abs(townLook.x)).toBeLessThan(wrap);
      expect(Math.abs(townLook.y)).toBeLessThan(wrap);
    }
  });
});
