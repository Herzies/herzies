import { CameraControls, CameraControlsImpl } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { ambient } from "./ambient";
import { combat } from "./combat/state";
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

/** Combat mode: the camera comes in over the right shoulder… */
const COMBAT = {
  distance: 6.4,
  /** …levelled off to look along the ground, not down at it… */
  polar: 1.5,
  /** …the herzie a little left of and below the crosshair… */
  shoulder: 1.75,
  lift: 1.05,
  look: 1.5,
  /** …free to look higher and lower than when walking… */
  minPolar: 0.55,
  maxPolar: 1.78,
  /** …turned by the mouse: radians per pixel moved. */
  sensitivity: 0.0024,
} as const;
const WALK_POLAR = { min: 0.85, max: 1.45 } as const;

/** Camera shake (Squirrel Eiserloh's "trauma"): hits add trauma, which
 * drains away; the camera shakes by its square, so small knocks barely
 * register and big ones jolt. Smooth noise, not random jitter. */
const SHAKE = { drain: 1.8, offset: 0.22, speed: 26 } as const;

/** Smooth noise in -1..1: a few sines at unrelated rates. */
const wave = (t: number, seed: number) =>
  Math.sin(t * 1.0 + seed) * 0.5 +
  Math.sin(t * 2.31 + seed * 1.7) * 0.3 +
  Math.sin(t * 4.79 + seed * 2.9) * 0.2;

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
  const fighting = useRef(false);
  const time = useRef(0);
  /** 0 walking to 1 in combat, eased. */
  const blend = useRef(0);

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
    time.current += delta;

    // Into or out of combat: over the shoulder, the mouse aiming — or back.
    if (combat.on !== fighting.current) {
      const on = combat.on;
      fighting.current = on;
      const look = on ? ACTION.NONE : ACTION.ROTATE;
      c.mouseButtons.left = look;
      c.mouseButtons.right = look;
      // Aiming wants the view right under the mouse: barely smoothed.
      c.smoothTime = on ? 0.03 : 0.12;
      c.draggingSmoothTime = on ? 0.01 : 0.04;
      c.minPolarAngle = on ? COMBAT.minPolar : WALK_POLAR.min;
      c.maxPolarAngle = on ? COMBAT.maxPolar : WALK_POLAR.max;
      const d = on ? COMBAT.distance : DISTANCE;
      c.minDistance = Math.min(d, c.distance);
      c.maxDistance = Math.max(d, c.distance);
      void c.dollyTo(d, true).then(() => {
        c.minDistance = c.maxDistance = fighting.current
          ? COMBAT.distance
          : DISTANCE;
      });
      combat.lookX = combat.lookY = 0;
      if (on) void c.rotatePolarTo(COMBAT.polar, true);
    }
    if (combat.on) {
      // Right looks right; up looks up.
      c.rotate(
        -combat.lookX * COMBAT.sensitivity,
        -combat.lookY * COMBAT.sensitivity,
        false,
      );
      combat.lookX = combat.lookY = 0;
    }
    // Eased between walking and combat framing, plus shake on top.
    blend.current = THREE.MathUtils.damp(
      blend.current,
      combat.on ? 1 : 0,
      10,
      delta,
    );
    const b = blend.current;
    combat.trauma = Math.max(0, combat.trauma - SHAKE.drain * delta);
    const k = combat.trauma ** 2;
    const t = time.current * SHAKE.speed;
    c.setFocalOffset(
      COMBAT.shoulder * b + wave(t, 1) * SHAKE.offset * k,
      -FRAMING_LIFT +
        (FRAMING_LIFT - COMBAT.lift) * b +
        wave(t, 7) * SHAKE.offset * k,
      0,
      false,
    );
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
    const lookHeight =
      LOOK_HEIGHT + (COMBAT.look - LOOK_HEIGHT) * blend.current;
    c.moveTo(at.current.x, at.current.y + lookHeight, at.current.z, false);
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
