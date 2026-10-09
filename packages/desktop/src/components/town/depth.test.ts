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
    const wind = new THREE.Vector2(1, 0);
    driftClouds(10, wind);
    const a = townLook.x;
    driftClouds(11, wind);
    expect(townLook.x).toBeLessThan(a);
    // Far enough on to have wrapped: still on the noise's own period.
    driftClouds(1e7, wind);
    expect(Math.abs(townLook.x)).toBeLessThan(14 * 256);
  });
});
