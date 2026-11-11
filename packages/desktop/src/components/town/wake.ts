import * as THREE from "three";
import { ambient } from "./ambient";

/**
 * What a duck leaves on the water, drawn on one flat quad each, in a
 * shader: no textures, one draw call for every duck on the island.
 *
 * How the pieces follow what water does (and how games fake it):
 *  - Only a moving duck leaves anything: a V trailing behind, its arms
 *    in the narrow cone real ducks make (the Kelvin wake, about 19.5° to
 *    the track), whose crests thin, spread and fade with distance; a
 *    bow wave arcing out in front; and a trail of foam down the middle
 *    and at the stern.
 *  - How much of it is a smooth `motion` value (0 still, 1 at full
 *    paddle), so the wake builds as the duck gets going and dies away
 *    as it comes to rest, instead of switching.
 *  - Hard-edged, a few levels of opacity, to sit with the Town's chunky
 *    pixels — not soft smears.
 *
 * Each quad is as big as the whole effect, centred on its duck and turned
 * with it; its shader works in the duck's own frame (+z forward).
 */

/** The quad's side, in world units: room for the wake. */
export const WAKE_SIZE = 7;
/** Where the duck's stern is, along its length: the wake starts here. */
const STERN = 0.3;

const vertexShader = /* glsl */ `
  attribute float motion;
  attribute float seed;
  varying vec2 vP;
  varying float vMotion;
  varying float vSeed;
  void main() {
    // The duck's own frame: x to its side, y forward, in world units.
    vP = position.xz * ${WAKE_SIZE.toFixed(1)};
    vMotion = motion;
    vSeed = seed;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uLight;
  varying vec2 vP;
  varying float vMotion;
  varying float vSeed;

  float hash( float n ) { return fract( sin( n ) * 43758.5453 ); }
  float noise1( float x ) {
    float i = floor( x );
    float f = fract( x );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( hash( i ), hash( i + 1.0 ), f );
  }
  // 1 on a ring of radius r (or a line r along), thinning to 0 across
  // a width w either side.
  float band( float d, float r, float w ) {
    return 1.0 - smoothstep( 0.0, w, abs( d - r ) );
  }

  void main() {
    vec2 p = vP;
    float t = uTime;
    float a = 0.0;

    // Moving: a wake behind, a bow wave in front.
    if ( vMotion > 0.02 ) {
      // How far behind the stern (positive behind it).
      float z = -( p.y + ${STERN.toFixed(2)} );
      if ( z > 0.0 ) {
        float length_ = 3.2;
        // The V: arms at the Kelvin angle, widening and thinning out,
        // each a train of crests that drift back along it.
        float arm = abs( abs( p.x ) - 0.36 * z );
        float w = 0.05 + 0.05 * z;
        float crest = 0.5 + 0.5 * sin( z * 8.5 - t * 3.2 + vSeed * 20.0 );
        float fade = pow( clamp( 1.0 - z / length_, 0.0, 1.0 ), 1.3 ) * smoothstep( 0.0, 0.3, z );
        a += band( arm, 0.0, w ) * mix( 0.45, 1.0, crest ) * fade * vMotion;
        // The foam down the middle, churned by the feet.
        float core = 1.0 - smoothstep( 0.0, 0.09 + 0.09 * z, abs( p.x ) );
        float churn = smoothstep( 0.4, 0.75, noise1( z * 7.0 - t * 2.4 + vSeed * 9.0 ) );
        a += core * churn * pow( clamp( 1.0 - z / 1.5, 0.0, 1.0 ), 1.4 ) * vMotion * 0.8;
      }
      // The bow wave: an arc pushed out ahead of the chest.
      if ( p.y > 0.0 ) {
        float bow = length( p - vec2( 0.0, 0.1 ) );
        a += band( bow, 0.55 + 0.04 * sin( t * 5.0 + vSeed ), 0.05 )
          * smoothstep( 0.0, 0.3, p.y ) * vMotion * 0.75;
      }
    }

    // A few hard levels, so it's crisp at the Town's resolution.
    a = clamp( a, 0.0, 1.0 );
    float level = floor( a * 3.0 + 0.35 ) / 3.0;
    if ( level < 0.3 ) discard;
    // Pale water-white, lit as the scene is (so at night it's dim).
    vec3 colour = vec3( 0.9, 0.96, 1.0 ) * max( uLight, vec3( 0.3 ) );
    gl_FragColor = vec4( colour, level * 0.85 );
    #include <colorspace_fragment>
  }
`;

/** The material every wake shares. */
export function wakeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: ambient.uTime, uLight: ambient.uLight },
    vertexShader,
    fragmentShader,
  });
}

/** A flat unit quad, with per-duck `motion` and `seed` attributes for
 * `count` ducks. */
export function wakeGeometry(count: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  g.setAttribute(
    "motion",
    new THREE.InstancedBufferAttribute(new Float32Array(count), 1),
  );
  g.setAttribute(
    "seed",
    new THREE.InstancedBufferAttribute(new Float32Array(count), 1),
  );
  return g;
}
