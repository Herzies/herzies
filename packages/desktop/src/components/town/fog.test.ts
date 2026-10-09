import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { cloudShadows, driftClouds } from "./fog";

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

  it("shares one cloud uniform with every lit material", () => {
    const lambert = THREE.UniformsUtils.clone(THREE.ShaderLib.lambert.uniforms);
    const standard = THREE.UniformsUtils.clone(
      THREE.ShaderLib.standard.uniforms,
    );
    expect(lambert.townClouds.value).toBe(cloudShadows);
    expect(standard.townClouds.value).toBe(cloudShadows);
    expect(THREE.ShaderLib.basic.uniforms.townClouds).toBeUndefined();
  });

  it("drifts the clouds downwind, wrapping without a jump", () => {
    const wind = new THREE.Vector2(1, 0);
    driftClouds(10, wind);
    const a = cloudShadows.x;
    driftClouds(11, wind);
    expect(cloudShadows.x).toBeLessThan(a);
    // Far enough on to have wrapped: still on the noise's own period.
    driftClouds(1e7, wind);
    expect(Math.abs(cloudShadows.x)).toBeLessThan(14 * 256);
  });
});
