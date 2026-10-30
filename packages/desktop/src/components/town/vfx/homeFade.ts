import { BlendFunction, Effect } from "postprocessing";
import * as THREE from "three";

/**
 * The world fading away at Home: the finished frame goes see-through, so
 * what's behind the canvas — the app's own background, and the sky an
 * equipped scenery item paints there — shows instead. Fading to nothing
 * rather than to a colour means it always matches the app's background,
 * whatever that is (the boss's black, the merchant's brown), to the pixel.
 *
 * The canvas is premultiplied, and this pass's output is encoded to sRGB
 * after it: so the colour's scaled by what's left of it in that encoding,
 * and handed back linear for the pass to encode again.
 *
 * Your herzie and Home's things are drawn again on top, unfaded (see
 * HomeLayer).
 */
export class HomeFadeEffect extends Effect {
  constructor() {
    super(
      "HomeFade",
      /* glsl */ `
      uniform float uFade;
      vec3 homeToScreen(vec3 c) {
        return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
      }
      vec3 homeFromScreen(vec3 c) {
        return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
      }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        if (uFade <= 0.0) { outputColor = inputColor; return; }
        float left = 1.0 - uFade;
        vec3 shown = homeToScreen(clamp(inputColor.rgb, 0.0, 1.0)) * left;
        outputColor = vec4(homeFromScreen(shown), left);
      }
    `,
      {
        blendFunction: BlendFunction.SET,
        uniforms: new Map<string, THREE.Uniform>([
          ["uFade", new THREE.Uniform(0)],
        ]),
      },
    );
  }

  /** 0: the world as it is; 1: gone. */
  set fade(v: number) {
    (this.uniforms.get("uFade") as THREE.Uniform<number>).value = v;
  }
}
