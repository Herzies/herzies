import { BlendFunction, Effect, EffectAttribute } from "postprocessing";
import * as THREE from "three";

/**
 * Bending light: how a sound wave shows in the air, the way heat haze and
 * shockwaves do in games — not drawn, but warping what's behind it.
 *
 * It's the usual distortion-buffer technique (Unreal's distortion pass,
 * Unity's): what distorts is drawn, each frame, into a buffer of its own
 * (`distortionScene`, into `DistortionBuffer`) as how far to shift the
 * picture at each pixel — a screen-space offset from the surface's normal,
 * strongest where it's seen edge-on, as a lens bends most at its rim — and
 * how far away it is. Then a pass over the finished frame
 * (`SonicDistortionEffect`) reads the picture shifted by those offsets,
 * splitting the colours a little along them (chromatic aberration), but
 * only where the wave is nearer than what's behind it, so a dummy or a
 * tree in front of a wave hides it.
 *
 * Overlapping waves add up their offsets and keep the nearest depth (the
 * buffer's alpha blends by min).
 */

/** What goes in the distortion buffer. Drawn with the scene's camera. */
export const distortionScene = new THREE.Scene();
distortionScene.matrixWorldAutoUpdate = true;

/** View distance is stored over this, in the buffer's alpha (half floats:
 * a few centimetres' precision across the island). */
export const DEPTH_RANGE = 400;

/** How strongly the waves bend light, in screen fractions at full strength.
 * Shared by every distortion material, so it can be tuned in one place. */
export const distortionUniforms = {
  uStrength: { value: 0.03 },
  uDepthRange: { value: DEPTH_RANGE },
};

/**
 * A material that draws a surface into the distortion buffer. Instanced:
 * each instance's `aFx.x` is how strong it is right now (0 gone, 1 full);
 * `aFx.y` its own edge falloff, 0 for a closed shape (a sphere: all
 * silhouette), up to 1 to fade a cap's open rim (see `capFade`).
 */
export function distortionMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: distortionUniforms,
    vertexShader: /* glsl */ `
      uniform float uDepthRange;
      attribute vec2 aFx;
      varying vec3 vNormalView;
      varying float vStrength;
      varying float vDepth;
      varying float vRim;
      void main() {
        vec4 world = instanceMatrix * vec4(position, 1.0);
        vec4 view = modelViewMatrix * world;
        vNormalView = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        vStrength = aFx.x;
        // A cap's open edge (its uv.y runs 1 at the apex to 0 at the rim,
        // see capGeometry): faded by aFx.y.
        vRim = mix(1.0, smoothstep(0.0, 0.45, uv.y), aFx.y);
        vDepth = -view.z / uDepthRange;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uStrength;
      varying vec3 vNormalView;
      varying float vStrength;
      varying float vDepth;
      varying float vRim;
      void main() {
        vec3 n = normalize(vNormalView) * (gl_FrontFacing ? 1.0 : -1.0);
        // Edge-on bends most: a lens's rim.
        float edge = 1.0 - abs(n.z);
        // A thin crest, like a ripple's, not a glass ball: strongest in a
        // band toward the rim.
        float k = vStrength * vRim * pow(edge, 1.6);
        vec2 offset = n.xy * k * uStrength;
        gl_FragColor = vec4(offset, k, vDepth);
      }
    `,
    side: THREE.DoubleSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.MinEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
  });
}

/** The buffer the distortion is drawn into: offsets, glow, depth. */
export class DistortionBuffer {
  readonly target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  private readonly clear = new THREE.Color(0, 0, 0);
  private readonly size = new THREE.Vector2();
  private readonly oldClear = new THREE.Color();

  /** Draws whatever's in distortionScene from `camera`, at the screen's
   * drawn size. Returns whether anything was drawn (nothing: the effect can
   * skip its work). */
  render(gl: THREE.WebGLRenderer, camera: THREE.Camera): boolean {
    gl.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x));
    const h = Math.max(1, Math.floor(this.size.y));
    if (this.target.width !== w || this.target.height !== h) {
      this.target.setSize(w, h);
    }
    let any = false;
    distortionScene.traverseVisible((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) {
        any ||= (o as THREE.InstancedMesh).count > 0;
      }
    });
    const before = gl.getRenderTarget();
    const alpha = gl.getClearAlpha();
    gl.getClearColor(this.oldClear);
    const autoClear = gl.autoClear;
    gl.setRenderTarget(this.target);
    gl.setClearColor(this.clear, 1);
    gl.autoClear = true;
    if (any) gl.render(distortionScene, camera);
    else gl.clear(true, false, false);
    gl.setRenderTarget(before);
    gl.setClearColor(this.oldClear, alpha);
    gl.autoClear = autoClear;
    return any;
  }

  dispose() {
    this.target.dispose();
  }
}

/** The pass that bends the frame by the distortion buffer. */
export class SonicDistortionEffect extends Effect {
  constructor(buffer: DistortionBuffer) {
    super(
      "SonicDistortion",
      /* glsl */ `
      uniform sampler2D tDistortion;
      uniform float uDepthRange;
      uniform float uChroma;
      uniform float uGlow;
      uniform float uActive;
      uniform float uWarp;
      void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
        if (uWarp > 0.0) {
          // Stepping through a portal: the whole view swirls in on itself
          // and whites out.
          vec2 c = uv - 0.5;
          float r = length(c);
          float turn = uWarp * 5.0 * (1.0 - smoothstep(0.0, 0.75, r));
          float cs = cos(turn), sn = sin(turn);
          c = mat2(cs, -sn, sn, cs) * c * (1.0 - uWarp * 0.35);
          vec2 w = c + 0.5;
          vec2 split = c * uWarp * 0.04;
          vec3 color = vec3(
            texture2D(inputBuffer, w + split).r,
            texture2D(inputBuffer, w).g,
            texture2D(inputBuffer, w - split).b
          );
          vec3 white = vec3(0.93, 0.88, 1.0);
          color = mix(color, white, smoothstep(0.55, 1.0, uWarp));
          outputColor = vec4(color, inputColor.a);
          return;
        }
        if (uActive < 0.5) { outputColor = inputColor; return; }
        vec4 d = texture2D(tDistortion, uv);
        // Only where the wave is in front of what's there.
        float scene = -getViewZ(depth) / uDepthRange;
        float seen = 1.0 - smoothstep(scene - 0.0004, scene + 0.0004, d.a);
        vec2 offset = d.xy * seen;
        float amount = length(offset);
        if (amount < 1e-5) { outputColor = inputColor; return; }
        // The colours part along the bend.
        vec2 split = offset * uChroma;
        vec3 color = vec3(
          texture2D(inputBuffer, uv + offset + split).r,
          texture2D(inputBuffer, uv + offset).g,
          texture2D(inputBuffer, uv + offset - split).b
        );
        // A faint brightening along the crest.
        color += d.b * seen * uGlow;
        outputColor = vec4(color, inputColor.a);
      }
    `,
      {
        attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
        blendFunction: BlendFunction.NORMAL,
        uniforms: new Map<string, THREE.Uniform>([
          ["tDistortion", new THREE.Uniform(buffer.target.texture)],
          ["uDepthRange", new THREE.Uniform(DEPTH_RANGE)],
          ["uChroma", new THREE.Uniform(0.55)],
          ["uGlow", new THREE.Uniform(0.035)],
          ["uActive", new THREE.Uniform(0)],
          ["uWarp", new THREE.Uniform(0)],
        ]),
      },
    );
  }

  /** How far through stepping through a portal, 0–1 (see warp). */
  set warp(k: number) {
    (this.uniforms.get("uWarp") as THREE.Uniform).value = k;
  }

  /** Whether there's anything to bend this frame. */
  set active(on: boolean) {
    (this.uniforms.get("uActive") as THREE.Uniform).value = on ? 1 : 0;
  }
}
