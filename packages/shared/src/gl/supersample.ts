import * as THREE from "three";

/** Drawn this many times the resolution each way when supersampling. */
export const SUPERSAMPLE = 2;

/**
 * Supersampling's last step: the canvas is drawn at SUPERSAMPLE times the
 * resolution, and here, once everything's on it, every pixel of each
 * block × block square takes the square's average. Scaled up without
 * smoothing, each square is then one chunky pixel, the same size as ever,
 * showing the average of what it covers rather than whatever one point of
 * it happened to hit.
 *
 * The finished frame's copied off the screen and drawn back averaged. For a
 * 2 × 2 block that's one read: the copy filters linearly, so reading at the
 * corner the four pixels share averages them. Colour and see-through alike,
 * premultiplied as the canvas is.
 */
export class SupersamplePass {
  private material: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera();
  private frame: THREE.FramebufferTexture | null = null;
  private size = new THREE.Vector2();

  constructor(block = SUPERSAMPLE) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uFrame: { value: null as THREE.Texture | null },
        uSize: { value: new THREE.Vector2(1, 1) },
        uBlock: { value: block },
      },
      vertexShader: /* glsl */ `
        void main() {
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uFrame;
        uniform vec2 uSize;
        uniform float uBlock;
        void main() {
          vec2 corner = (floor(gl_FragCoord.xy / uBlock) + 0.5) * uBlock;
          gl_FragColor = texture2D(uFrame, corner / uSize);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** Average what's on the screen, in place. The viewport must cover the
   * whole drawing buffer, with no scissor. */
  apply(gl: THREE.WebGLRenderer): void {
    const size = gl.getDrawingBufferSize(this.size);
    let frame = this.frame;
    if (
      !frame ||
      frame.image.width !== size.x ||
      frame.image.height !== size.y
    ) {
      frame?.dispose();
      frame = new THREE.FramebufferTexture(size.x, size.y);
      frame.minFilter = THREE.LinearFilter;
      frame.magFilter = THREE.LinearFilter;
      this.frame = frame;
      this.material.uniforms.uFrame.value = frame;
      (this.material.uniforms.uSize.value as THREE.Vector2).copy(size);
    }
    gl.setRenderTarget(null);
    gl.copyFramebufferToTexture(frame);
    const autoClear = gl.autoClear;
    gl.autoClear = false;
    gl.render(this.scene, this.camera);
    gl.autoClear = autoClear;
  }

  dispose(): void {
    this.frame?.dispose();
    this.frame = null;
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
