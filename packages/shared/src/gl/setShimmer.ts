import * as THREE from "three";

/*
 * A full set's shimmer (ItemSet.shimmer): a few sparkles drifting up and
 * round the herzie, in the set's two colours. Made to sit in the
 * background: noticed by whoever's looking, never in the way.
 *
 * The sparkles are one crisp pixel each, on or off, never a smudge. Each
 * climbs from the feet to over the head on a loose spiral, in and out of
 * view, and twinkles as it goes; a few at a time, never a swarm.
 *
 * All of it runs on the GPU off one clock: nothing moves on the CPU, and
 * nothing is allocated per frame. Sizes are in the herzie's height, so it
 * looks the same at any scale. Premultiplied, so it adds light without
 * washing out what's behind it.
 */

/** Sparkles per herzie. */
const SPARKLES = 28;
/** Seconds for a sparkle to climb the herzie, roughly (each varies). */
const CLIMB_SECONDS = 4.5;

export interface ShimmerColors {
  /** Most sparkles (white, for FF). */
  core: string;
  /** The rest of the sparkles (pink, for FF). */
  edge: string;
  /** Sparkles (the default) or bubbles: a few round bubbles, a ring with a
   * glint, wobbling up past the herzie slower than sparkles climb and
   * popping at the top (the Streetsmart set's milk froth). */
  style?: "sparkle" | "bubble";
}

/** Bubbles per herzie: fewer than sparkles, they're bigger. */
const BUBBLES = 12;
/** Seconds for a bubble to rise past the herzie, roughly. */
const RISE_SECONDS = 6.5;

const blending: Partial<THREE.ShaderMaterialParameters> = {
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};

function seededPoints(count: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(count * 3), 3),
  );
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) seeds[i] = (i + 0.5) / count;
  g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  return g;
}

const sparkleGeometry = seededPoints(SPARKLES);
const bubbleGeometry = seededPoints(BUBBLES);

/*
 * Bubbles: each rises from about the knees to over the head on a slow
 * sideways wobble, a little out from the herzie, and pops at the top (a
 * quick swell, then gone). Drawn as a crisp ring a few pixels across with a
 * glint up on one side and the faintest fill: stepped edges, never a blur.
 */
const bubbleVertex = /* glsl */ `
  uniform float uTime;
  uniform float uHeight;
  uniform float uWidth;
  uniform float uClimb;
  attribute float aSeed;
  varying float vAlpha;
  varying float vTint;
  float hash(float n) { return fract(sin(n * 91.345) * 47453.5453); }
  void main() {
    float speed = 1.0 / (uClimb * mix(0.8, 1.3, hash(aSeed)));
    float t = fract(uTime * speed + hash(aSeed + 1.0));
    float turn = aSeed * 23.0 + hash(aSeed + 2.0) * 6.2832;
    float r = uWidth * mix(0.5, 0.75, hash(aSeed + 3.0));
    float wobble = sin(uTime * mix(1.6, 2.6, hash(aSeed + 6.0)) + aSeed * 40.0)
      * uWidth * 0.06;
    vec3 p = vec3(
      cos(turn) * r + wobble,
      mix(0.15, 1.15, t) * uHeight,
      sin(turn) * r
    );
    // In over the first tenth; at the top it swells, then pops.
    float pop = smoothstep(0.86, 0.94, t);
    vAlpha = step(0.08, t) * (1.0 - step(0.94, t));
    vTint = step(0.55, hash(aSeed + 5.0));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float size = mix(0.75, 1.2, hash(aSeed + 7.0)) * (1.0 + pop * 0.15);
    // A few pixels across at any distance: big enough to be a ring, never
    // a blob.
    gl_PointSize = floor(clamp(0.06 * uHeight * 200.0 / -mv.z, 4.0, 7.0) * size + 0.5);
    gl_Position = projectionMatrix * mv;
  }
`;

const bubbleFragment = /* glsl */ `
  uniform float uOpacity;
  uniform vec3 uCore;
  uniform vec3 uEdge;
  varying float vAlpha;
  varying float vTint;
  void main() {
    vec2 pc = gl_PointCoord - 0.5;
    float d = length(pc) * 2.0;
    if (d > 1.0) discard;
    float ring = step(0.68, d);
    float glint = step(length(pc - vec2(-0.17, -0.17)), 0.12);
    vec3 rim = mix(uCore, uEdge, vTint);
    float a = (ring * 0.8 + glint * 0.95 + 0.012) * vAlpha * uOpacity;
    vec3 c = glint > 0.5 ? vec3(1.0) : ring > 0.5 ? rim : uCore;
    gl_FragColor = vec4(c * a, a);
    #include <colorspace_fragment>
  }
`;

export class SetShimmer {
  /** Add to the herzie's root (its feet). */
  readonly group = new THREE.Group();
  private readonly uTime = { value: 0 };
  private readonly uOpacity = { value: 1 };
  private readonly sparkleMaterial: THREE.ShaderMaterial;

  /** `height` and `width`: the herzie's, in world units. */
  constructor(colors: ShimmerColors, height: number, width: number) {
    const core = { value: new THREE.Color(colors.core) };
    const edge = { value: new THREE.Color(colors.edge) };
    if (colors.style === "bubble") {
      this.sparkleMaterial = new THREE.ShaderMaterial({
        uniforms: {
          uTime: this.uTime,
          uOpacity: this.uOpacity,
          uCore: core,
          uEdge: edge,
          uHeight: { value: height },
          uWidth: { value: width },
          uClimb: { value: RISE_SECONDS },
        },
        vertexShader: bubbleVertex,
        fragmentShader: bubbleFragment,
        ...blending,
      });
      const bubbles = new THREE.Points(bubbleGeometry, this.sparkleMaterial);
      bubbles.frustumCulled = false;
      this.group.add(bubbles);
      return;
    }
    this.sparkleMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uTime,
        uOpacity: this.uOpacity,
        uCore: core,
        uEdge: edge,
        uHeight: { value: height },
        uWidth: { value: width },
        uClimb: { value: CLIMB_SECONDS },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uHeight;
        uniform float uWidth;
        uniform float uClimb;
        attribute float aSeed;
        varying float vAlpha;
        varying float vPink;
        float hash(float n) { return fract(sin(n * 91.345) * 47453.5453); }
        void main() {
          float speed = 1.0 / (uClimb * mix(0.8, 1.25, hash(aSeed)));
          float t = fract(uTime * speed + hash(aSeed + 1.0));
          // A loose spiral round the herzie, a little out from it.
          float turn = aSeed * 37.0 + t * mix(1.5, 3.0, hash(aSeed + 2.0));
          float r = uWidth * mix(0.45, 0.7, hash(aSeed + 3.0));
          vec3 p = vec3(
            cos(turn) * r,
            mix(0.05, 1.1, t) * uHeight,
            sin(turn) * r
          );
          // In over the first fifth, out over the last, and a twinkle:
          // on or off, never in between (one crisp pixel).
          float life = smoothstep(0.0, 0.2, t) * (1.0 - smoothstep(0.75, 1.0, t));
          float twinkle = step(0.35, sin(uTime * mix(5.0, 9.0, hash(aSeed + 4.0)) + aSeed * 50.0));
          vAlpha = step(0.5, life) * twinkle;
          vPink = step(0.6, hash(aSeed + 5.0));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          // A pinpoint at any distance: one or two pixels, never a square.
          gl_PointSize = clamp(0.035 * uHeight * 200.0 / -mv.z, 1.0, 2.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        uniform vec3 uCore;
        uniform vec3 uEdge;
        varying float vAlpha;
        varying float vPink;
        void main() {
          float a = vAlpha * 0.85 * uOpacity;
          vec3 c = mix(mix(uCore, vec3(1.0), 0.4), uEdge, vPink);
          gl_FragColor = vec4(c * a, a);
          #include <colorspace_fragment>
        }
      `,
      ...blending,
    });
    const sparkles = new THREE.Points(sparkleGeometry, this.sparkleMaterial);
    sparkles.frustumCulled = false;
    this.group.add(sparkles);
  }

  update(dt: number): void {
    this.uTime.value += dt;
  }

  /** Fades with the herzie (setTint's opacity). */
  setOpacity(opacity: number): void {
    this.uOpacity.value = opacity;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.sparkleMaterial.dispose();
  }
}
