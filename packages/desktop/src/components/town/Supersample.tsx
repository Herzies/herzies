import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { SUPERSAMPLE } from "./pixelSize";

/**
 * Supersampling's last step (see pixelSize.ts): the canvas is drawn at
 * SUPERSAMPLE times the resolution, and here, once everything's on it —
 * the world through the composer, Home's layer over it (see HomeLayer) —
 * every pixel of each block × block square takes the square's average.
 * Scaled up without smoothing, each square is then one chunky pixel, the
 * same size as ever, showing the average of what it covers rather than
 * whatever one point of it happened to hit.
 *
 * The finished frame's copied off the screen and drawn back averaged. For a
 * 2 × 2 block that's one read: the copy filters linearly, so reading at the
 * corner the four pixels share averages them. Colour and see-through alike
 * (Home's canvas is see-through round the herzie), premultiplied as the
 * canvas is.
 */
export function Supersample({ block = SUPERSAMPLE }: { block?: number }) {
  const gl = useThree((s) => s.gl);
  const pass = useMemo(() => {
    const material = new THREE.ShaderMaterial({
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
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    return {
      material,
      quad,
      scene,
      camera: new THREE.OrthographicCamera(),
      frame: null as THREE.FramebufferTexture | null,
      size: new THREE.Vector2(),
    };
  }, [block]);
  useEffect(
    () => () => {
      pass.frame?.dispose();
      pass.material.dispose();
      pass.quad.geometry.dispose();
    },
    [pass],
  );

  // After the composer (1) and Home's layer (2).
  useFrame(() => {
    const size = gl.getDrawingBufferSize(pass.size);
    let frame = pass.frame;
    if (
      !frame ||
      frame.image.width !== size.x ||
      frame.image.height !== size.y
    ) {
      frame?.dispose();
      frame = new THREE.FramebufferTexture(size.x, size.y);
      frame.minFilter = THREE.LinearFilter;
      frame.magFilter = THREE.LinearFilter;
      pass.frame = frame;
      pass.material.uniforms.uFrame.value = frame;
      (pass.material.uniforms.uSize.value as THREE.Vector2).copy(size);
    }
    gl.setRenderTarget(null);
    gl.copyFramebufferToTexture(frame);
    const autoClear = gl.autoClear;
    gl.autoClear = false;
    gl.render(pass.scene, pass.camera);
    gl.autoClear = autoClear;
  }, 3);

  return null;
}
