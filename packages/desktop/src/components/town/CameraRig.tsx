import { CameraControls, CameraControlsImpl } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { ambient } from "./ambient";
import { townSave, useTownRuntime } from "./runtime";

const { ACTION } = CameraControlsImpl;

/** What the camera orbits: the player's chest. */
const LOOK_HEIGHT = 1;
/** How far the camera sits from the player. Fixed: there is no zoom. */
const DISTANCE = 12;
/** How far the view is shifted up past the player, in world units, so the
 * player stands a little below the middle of the screen. */
const FRAMING_LIFT = 1.4;
/** Arrow-key camera speeds, in radians per second. */
const KEY_TURN_SPEED = 2;
const KEY_TILT_SPEED = 1;

/**
 * The third-person camera: camera-controls orbiting the player, which it
 * follows every frame. Either mouse button orbits (the right one also turns
 * the player — see Player), so do the arrow keys (left/right orbit, up/down
 * tilt). There is no zoom, and nothing pushes the camera in: whatever's
 * between it and the player turns see-through instead (`seeThrough`).
 *
 * Scheduling: physics steps (and interpolates the player) at priority -3,
 * this re-centres on the interpolated player at -2, and drei's controls
 * update at -1 — so the camera never lags a frame behind the player, which
 * is what makes a follow camera jitter.
 */
export function CameraRig() {
  const rt = useTownRuntime();
  const camera = useThree((s) => s.camera);
  const controls = useRef<CameraControlsImpl>(null);
  const at = useRef(new THREE.Vector3());

  // Restore where the camera was, and save it again on the way out.
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    c.moveTo(townSave.x, LOOK_HEIGHT, townSave.z, false);
    c.rotateTo(townSave.azimuth, townSave.polar, false);
    c.dollyTo(DISTANCE, false);
    // Shifts camera and target together, so orbiting still turns about the
    // player.
    // (camera-controls' offset is in screen space, y down.)
    c.setFocalOffset(0, -FRAMING_LIFT, 0, false);
    return () => {
      townSave.azimuth = c.azimuthAngle;
      townSave.polar = c.polarAngle;
    };
  }, []);

  useFrame((_, delta) => {
    const c = controls.current;
    const body = rt.playerBody;
    if (!c || !body) return;
    const input = rt.input.current;
    if (input) {
      // Left looks left: a growing azimuth swings the view anticlockwise.
      // Up looks up, so the camera drops toward the ground.
      const turn = Number(input.turnLeft) - Number(input.turnRight);
      const tilt = Number(input.tiltUp) - Number(input.tiltDown);
      if (turn || tilt) {
        c.rotate(
          turn * KEY_TURN_SPEED * delta,
          tilt * KEY_TILT_SPEED * delta,
          true,
        );
      }
    }
    body.getWorldPosition(at.current);
    c.moveTo(at.current.x, at.current.y + LOOK_HEIGHT, at.current.z, false);
    // Where the player is as the camera sees it, for whatever's in the way
    // to turn see-through (see `seeThrough`). The camera last moved a frame
    // ago, which is close enough.
    ambient.uPlayerView.value
      .copy(at.current)
      .setY(at.current.y + LOOK_HEIGHT)
      .applyMatrix4(camera.matrixWorldInverse);
    rt.cameraAzimuth = c.azimuthAngle;
  }, -2);

  return (
    <CameraControls
      ref={controls}
      makeDefault
      minDistance={DISTANCE}
      maxDistance={DISTANCE}
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
        middle: ACTION.NONE,
        wheel: ACTION.NONE,
      }}
      touches={{
        one: ACTION.TOUCH_ROTATE,
        two: ACTION.TOUCH_ROTATE,
        three: ACTION.NONE,
      }}
    />
  );
}
