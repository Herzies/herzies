import { BlendFunction, Effect } from "postprocessing";
import * as THREE from "three";

/**
 * Falling rain, drawn over the finished frame in the screen's own pixels:
 * the way most games (and every pixel-art one) do it, rather than
 * thousands of 3D streaks that turn into slanted sticks as the camera
 * swings.
 *
 *  - Three layers of parallax. Far drops are short, faint, slow and
 *    dense; near ones long, bright, fast and few — so the rain has depth,
 *    and none of it is the same drop twice.
 *  - Each is one pixel wide on the Town's own pixel grid (supersampling
 *    taken out), a head that leads and a tail that fades in a few hard
 *    steps — crisp, like the rest of the Town, not smeared.
 *  - Lengths and brightness vary drop to drop, and gaps are random, so it
 *    reads as weather rather than a pattern.
 *  - Tinted near the scene's own colours (pale and cool, dimmed with the
 *    light) and kept faint: rain that's too bright reads as noise.
 *  - Its cost doesn't depend on how hard it rains: three cheap hashes a
 *    pixel, nothing to move on the CPU.
 *
 * The splashes where drops land are in 3D (see Rain.tsx), near the player
 * only.
 */
export class RainOverlayEffect extends Effect {
  constructor() {
    super(
      "RainOverlay",
      /* glsl */ `
      uniform float uTime;
      uniform float uRain;
      uniform float uTilt;
      uniform float uBlock;
      uniform vec3 uLight;

      float rainHash( vec2 p ) {
        return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
      }

      // One layer: columns of pixel-wide drops falling at a slant. Every
      // cell of cw x ch pixels may hold one drop, in a random column of
      // it, at a random height, with its own length and brightness.
      float rainLayer( vec2 px, float cw, float ch, float speed, vec2 lens, float density, float seed ) {
        // Sheared so the drops lean; moving down as time goes on.
        vec2 q = vec2( px.x - px.y * uTilt, px.y + uTime * speed );
        float col = floor( q.x / cw );
        float row = floor( q.y / ch );
        vec2 id = vec2( col, row ) + seed;
        if ( rainHash( id ) > density * uRain ) return 0.0;
        float x = floor( q.x ) - col * cw;
        if ( abs( x - floor( rainHash( id + 1.7 ) * cw ) ) > 0.5 ) return 0.0;
        float head = ch * ( 0.15 + 0.7 * rainHash( id + 5.3 ) );
        float d = ( q.y - row * ch ) - head;
        float len = mix( lens.x, lens.y, rainHash( id + 3.1 ) );
        if ( d < 0.0 || d > len ) return 0.0;
        // Bright at the head, fading up the tail in three steps.
        float a = ceil( ( 1.0 - d / len ) * 3.0 ) / 3.0;
        return a * mix( 0.45, 1.0, rainHash( id + 9.1 ) );
      }

      void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
        if ( uRain <= 0.01 ) {
          outputColor = inputColor;
          return;
        }
        // The Town's own pixels, whole ones: where this pixel is on the
        // grid the drops are drawn on.
        vec2 px = floor( uv * resolution / uBlock );
        float a = 0.0;
        a = max( a, 0.22 * rainLayer( px, 6.0, 44.0, 150.0, vec2( 6.0, 12.0 ), 0.55, 0.0 ) );
        a = max( a, 0.34 * rainLayer( px, 11.0, 78.0, 250.0, vec2( 12.0, 24.0 ), 0.45, 31.0 ) );
        a = max( a, 0.5 * rainLayer( px, 19.0, 140.0, 400.0, vec2( 24.0, 48.0 ), 0.35, 67.0 ) );
        vec3 tint = vec3( 0.8, 0.88, 0.96 ) * max( uLight, vec3( 0.35 ) );
        // Rain on the scene's own colours: lifted toward the tint.
        outputColor = vec4( mix( inputColor.rgb, tint, a ), inputColor.a );
      }
    `,
      {
        blendFunction: BlendFunction.SET,
        uniforms: new Map<string, THREE.Uniform>([
          ["uTime", new THREE.Uniform(0)],
          ["uRain", new THREE.Uniform(0)],
          ["uTilt", new THREE.Uniform(0.12)],
          ["uBlock", new THREE.Uniform(1)],
          ["uLight", new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ]),
      },
    );
  }

  /** What to draw this frame: the time, how hard it rains (0 skips the
   * pass), the slant (drops lean one way per unit of height), the size of
   * a Town pixel in drawing-buffer pixels, and the scene's light. */
  set(
    time: number,
    rain: number,
    tilt: number,
    block: number,
    light: THREE.Color,
  ) {
    const u = this.uniforms;
    (u.get("uTime") as THREE.Uniform<number>).value = time;
    (u.get("uRain") as THREE.Uniform<number>).value = rain;
    (u.get("uTilt") as THREE.Uniform<number>).value = tilt;
    (u.get("uBlock") as THREE.Uniform<number>).value = block;
    (u.get("uLight") as THREE.Uniform<THREE.Color>).value.copy(light);
  }
}
