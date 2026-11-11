import { BlendFunction, Effect } from "postprocessing";
import * as THREE from "three";

/**
 * The Town's grade: a soft vignette, so the edges of the frame fall away
 * a little and the middle (where the herzie is) reads brighter, and a
 * warm cast in the golden hours either side of sunrise and sunset. Both
 * slight: the Town's colours are its own, and this only leans on them.
 * One pass on the finished frame, folded into the composer that's
 * already there (see Post).
 */
export class LookEffect extends Effect {
  constructor() {
    super(
      "TownLook",
      /* glsl */ `
      uniform float uVignette;
      uniform float uWarm;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = inputColor.rgb;
        // The corners, darkened: wide and gentle, nothing near the middle.
        vec2 d = (uv - 0.5) * vec2(1.0, 0.85);
        float edge = smoothstep(0.45, 1.0, length(d) * 1.45);
        c *= 1.0 - uVignette * edge;
        // Golden hour: warmer and a touch richer.
        c *= mix(vec3(1.0), vec3(1.07, 0.985, 0.9), uWarm);
        outputColor = vec4(c, inputColor.a);
      }
    `,
      {
        blendFunction: BlendFunction.SET,
        uniforms: new Map<string, THREE.Uniform>([
          ["uVignette", new THREE.Uniform(0.2)],
          ["uWarm", new THREE.Uniform(0)],
        ]),
      },
    );
  }

  /** How dark the corners go, 0–1. */
  set vignette(v: number) {
    (this.uniforms.get("uVignette") as THREE.Uniform<number>).value = v;
  }

  /** How golden the hour is, 0–1. */
  set warm(v: number) {
    (this.uniforms.get("uWarm") as THREE.Uniform<number>).value = v;
  }
}
