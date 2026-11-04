import { Effect } from "postprocessing";
import * as THREE from "three";

/**
 * Supersampling down to the Town's big pixels: the frame's drawn at
 * `block` times the resolution, and this, last, gives every pixel of each
 * block × block square the square's average. Scaled up without smoothing,
 * each square is then one chunky pixel, the same size as ever, showing the
 * average of what it covers — edges, thin poles, shader detail and shadows
 * alike — rather than whatever one point of it happened to hit.
 *
 * For a 2 × 2 block it's one read: the frame's buffers filter linearly, so
 * reading at the corner the four pixels share averages them.
 */
export class BlockAverageEffect extends Effect {
  constructor(block = 2) {
    super(
      "BlockAverage",
      /* glsl */ `
      uniform float uBlock;
      void mainUv(inout vec2 uv) {
        vec2 corner = (floor(uv * resolution / uBlock) + 0.5) * uBlock;
        uv = corner / resolution;
      }
    `,
      {
        uniforms: new Map<string, THREE.Uniform>([
          ["uBlock", new THREE.Uniform(block)],
        ]),
      },
    );
  }
}
