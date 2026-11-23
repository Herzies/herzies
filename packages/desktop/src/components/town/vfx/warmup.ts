import * as THREE from "three";
import { pillarWarmup } from "../combat/LootDrops";
import { telegraphWarmup } from "../combat/Telegraphs";
import { distortionScene } from "./distortion";

/**
 * Shaders that aren't in the scene until they're needed, compiled with it
 * (see World's Precompile), so the first of each doesn't stall a frame:
 * the waves' distortion buffer, a scene of its own drawn only once
 * something's in it; and the boss's telegraphs and the loot pillars, made
 * as they come.
 */

/** Holds what's only ever compiled, never drawn. */
const unseen = new THREE.Scene();
unseen.add(...telegraphWarmup, pillarWarmup);

/** Like DistortionBuffer's target, so its shaders are the ones it uses. */
const DISTORTION_TARGET = new THREE.WebGLRenderTarget(1, 1, {
  type: THREE.HalfFloatType,
  format: THREE.RGBAFormat,
  depthBuffer: false,
});

/** Compiles the above, in the background. Call with the render target the
 * scene is drawn into bound; it's bound again after. */
export function compileUnseen(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): void {
  // Lit and fogged as the scene is, though not in it.
  gl.compileAsync(unseen, camera, scene);
  const was = gl.getRenderTarget();
  gl.setRenderTarget(DISTORTION_TARGET);
  gl.compileAsync(distortionScene, camera);
  gl.setRenderTarget(was);
}
