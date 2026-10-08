import { CameraControls, CameraControlsImpl } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { townSave, useTownRuntime } from "./runtime";

const { ACTION } = CameraControlsImpl;

/** What the camera looks at: the player's chest, so they sit centred. */
const LOOK_HEIGHT = 1;

/**
 * The third-person camera: camera-controls orbiting the player, which it
 * follows every frame. Either mouse button orbits (the right one also turns
 * the player — see Player), the wheel zooms, and the trees push the camera
 * in rather than letting it clip through them.
 *
 * Scheduling: physics steps (and interpolates the player) at priority -3,
 * this re-centres on the interpolated player at -2, and drei's controls
 * update at -1 — so the camera never lags a frame behind the player, which
 * is what makes a follow camera jitter.
 */
export function CameraRig({ colliders }: { colliders: THREE.Object3D[] }) {
  const rt = useTownRuntime();
  const controls = useRef<CameraControlsImpl>(null);
  const at = useRef(new THREE.Vector3());

  // Restore where the camera was, and save it again on the way out.
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    c.moveTo(townSave.x, LOOK_HEIGHT, townSave.z, false);
    c.rotateTo(townSave.azimuth, townSave.polar, false);
    c.dollyTo(townSave.distance, false);
    return () => {
      townSave.azimuth = c.azimuthAngle;
      townSave.polar = c.polarAngle;
      townSave.distance = c.distance;
    };
  }, []);

  useEffect(() => {
    if (controls.current) controls.current.colliderMeshes = colliders;
  }, [colliders]);

  useFrame(() => {
    const c = controls.current;
    const body = rt.playerBody;
    if (!c || !body) return;
    body.getWorldPosition(at.current);
    c.moveTo(at.current.x, at.current.y + LOOK_HEIGHT, at.current.z, false);
    rt.cameraAzimuth = c.azimuthAngle;
  }, -2);

  return (
    <CameraControls
      ref={controls}
      makeDefault
      minDistance={3.5}
      maxDistance={12}
      // Polar angle is from straight up: keep between a high three-quarter
      // view and just above the ground.
      minPolarAngle={0.85}
      maxPolarAngle={1.45}
      smoothTime={0.12}
      draggingSmoothTime={0.04}
      dollyToCursor={false}
      mouseButtons={{
        left: ACTION.ROTATE,
        right: ACTION.ROTATE,
        middle: ACTION.DOLLY,
        wheel: ACTION.DOLLY,
      }}
      touches={{
        one: ACTION.TOUCH_ROTATE,
        two: ACTION.TOUCH_DOLLY,
        three: ACTION.NONE,
      }}
    />
  );
}
