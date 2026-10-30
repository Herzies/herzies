import { CameraControls, CameraControlsImpl } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { ambient } from "./ambient";
import { aimSensitivity } from "./combat/sensitivity";
import { combat } from "./combat/state";
import { blendPose, type HomePose, homeAzimuth, homePose } from "./homeCamera";
import { type HomeFrame, homeMode } from "./homeMode";
import { groundY, type TownMap } from "./map";
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

/** How high and how low the camera may go (polar angle from straight up;
 * 1.57 is level with the herzie), walking or fighting alike. */
const WALK_POLAR = { min: 0.85, max: 1.6 } as const;

/** Combat mode keeps the walking camera: same distance, same tilt limits,
 * same angle. The mouse still aims by turning the view. The one change is
 * that the herzie sits lower on the screen, so the crosshair in the middle
 * isn't right on top of it. (It used to come in over the shoulder and level
 * off; that is gone.) */
const COMBAT = {
  distance: DISTANCE,
  shoulder: 0,
  /** How far up the view is shifted past the player: more than walking, so
   * the herzie stands lower, clear of the crosshair. */
  lift: FRAMING_LIFT + 0.5,
  look: LOOK_HEIGHT,
  minPolar: WALK_POLAR.min,
  maxPolar: WALK_POLAR.max,
} as const;

/** Aiming turns this much of what dragging the view would: precise, not
 * sweeping. */
const AIM_SCALE = 0.25;

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
/** How far above the ground the camera keeps, so a hill behind you never
 * swallows it. */
const GROUND_CLEARANCE = 0.8;

/** How quickly Home's framing follows a change to it (the deck opening over
 * Home pulls the camera back): the fraction of the way per 60fps frame, as
 * Home's own view eases it. */
const HOME_FRAME_EASE = 0.1;
/** Home's framing before the app has laid Home out: about where it stands
 * the herzie in the small window. */
const FALLBACK_FRAME = (height: number): HomeFrame => ({
  feetY: Math.round(height * 0.62),
  viewHeight: 304,
  zoom: 1,
});
/** At Home the camera drifts round the herzie a touch, slowly, so the
 * picture breathes instead of freezing: this far (radians) either way, over
 * this long (seconds). */
const HOME_DRIFT = { angle: 0.02, period: 14 } as const;

export function CameraRig({ map }: { map?: TownMap }) {
  const rt = useTownRuntime();
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const controls = useRef<CameraControlsImpl>(null);
  const at = useRef(new THREE.Vector3());
  const eye = useRef(new THREE.Vector3());
  const fighting = useRef(false);
  const time = useRef(0);
  /** 0 walking to 1 in combat, eased. */
  const blend = useRef(0);
  /** The arrival the view last swung round for (see townSave.arrival). */
  const arrived = useRef(townSave.arrival);
  /** Home's side of the camera (see homeMode). */
  const home = useRef({
    /** The visit the azimuth below was taken for. */
    visit: -1,
    /** Where the camera stands round the herzie at Home: fixed for the
     * visit, so spinning the herzie turns it, not the view. */
    azimuth: 0,
    /** Home's framing, eased toward what the app asks for. */
    frame: null as HomeFrame | null,
    /** At Home (or on the way) last frame. */
    on: false,
    /** The lens it had before Home changed it. */
    fov: 0,
    /** The view's been changed for Home and must be put back. */
    touched: false,
    pose: {
      position: new THREE.Vector3(),
      target: new THREE.Vector3(),
      fov: 0,
      pan: 0,
    } as HomePose,
    center: new THREE.Vector3(),
    feet: new THREE.Vector3(),
    follow: new THREE.Vector3(),
    followTarget: new THREE.Vector3(),
    forward: new THREE.Vector3(),
    position: new THREE.Vector3(),
    target: new THREE.Vector3(),
  });

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
    homeMode.step(delta);
    // Leaving Home: the camera it swings back to is behind the herzie,
    // looking the way it faces (it'll walk off that way).
    const h = home.current;
    if (h.on && !homeMode.on && rt.playerHerzie) {
      c.rotateTo(rt.playerHerzie.heading - Math.PI, c.polarAngle, false);
    }
    h.on = homeMode.on;
    // At Home a drag spins the herzie (see HomeSpin), not the view.
    c.enabled = !combat.on && !homeMode.on;

    // Just arrived (through a portal, into the cave, respawned): behind the
    // herzie, looking the way it faces — not wherever the view last was.
    if (arrived.current !== townSave.arrival) {
      arrived.current = townSave.arrival;
      c.moveTo(townSave.x, LOOK_HEIGHT, townSave.z, false);
      c.rotateTo(townSave.azimuth, c.polarAngle, false);
    }

    // Into or out of combat: the mouse aims (the view itself stays put).
    if (combat.on !== fighting.current) {
      const on = combat.on;
      fighting.current = on;
      const look = on ? ACTION.NONE : ACTION.ROTATE;
      c.mouseButtons.left = look;
      c.mouseButtons.right = look;
      // Drags must not also turn the view (the aim already does): off
      // altogether while fighting, so a held cast can't double the turn.
      c.enabled = !on && !homeMode.on;
      // Aiming wants the view right under the mouse: barely smoothed.
      c.smoothTime = on ? 0.04 : 0.12;
      c.draggingSmoothTime = 0.04;
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
    }
    if (combat.on) {
      // Dragging the view's way (camera-controls' own scale: a full turn per
      // screen height of movement, eased the same), scaled down to aim, times
      // the chosen sensitivity. Right looks right; up looks up.
      const perPixel =
        ((2 * Math.PI) / Math.max(1, size.height)) *
        AIM_SCALE *
        aimSensitivity();
      c.rotate(-combat.lookX * perPixel, -combat.lookY * perPixel, true);
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
    // Never inside a hill: tip the view up until the camera clears the
    // ground behind it (its height over what it looks at is
    // distance · cos(polar)).
    if (map) {
      c.getPosition(eye.current);
      const floor =
        groundY(map, eye.current.x, eye.current.z) + GROUND_CLEARANCE;
      if (eye.current.y < floor) {
        const rise = floor - (at.current.y + lookHeight);
        const most = Math.acos(
          THREE.MathUtils.clamp(rise / Math.max(c.distance, 0.01), -1, 1),
        );
        if (c.polarAngle > most) c.rotatePolarTo(most, false);
      }
    }
    // Where the player is as the camera sees it, for whatever's in the way
    // to turn see-through (see `seeThrough`). The camera last moved a frame
    // ago, which is close enough.
    ambient.uPlayerView.value
      .copy(at.current)
      .setY(at.current.y + LOOK_HEIGHT)
      .applyMatrix4(camera.matrixWorldInverse);
    rt.cameraAzimuth = c.azimuthAngle;
  }, -2);

  // Home: once the controls have placed the camera behind the herzie (at
  // -1), carried from there toward Home's pose by the blend — before
  // anything reads the camera (name tags, the frame itself).
  useFrame((_, delta) => {
    const h = home.current;
    const b = homeMode.blend;
    const herzie = rt.playerHerzie;
    const body = rt.playerBody;
    const cam = camera as THREE.PerspectiveCamera;
    if (!h.touched) h.fov = cam.fov;
    if (b <= 0 || !herzie || !body) {
      if (h.touched) {
        h.touched = false;
        cam.fov = h.fov;
        cam.clearViewOffset();
        cam.updateProjectionMatrix();
      }
      return;
    }
    if (h.visit !== homeMode.visit) {
      h.visit = homeMode.visit;
      h.azimuth = homeAzimuth(herzie.heading);
      homeMode.setAzimuth(h.azimuth);
    }
    // Home's framing, eased toward the app's (see HOME_FRAME_EASE).
    const want = homeMode.frame ?? FALLBACK_FRAME(size.height);
    if (!h.frame || b < 1e-3) h.frame = { ...want };
    else {
      const k = 1 - (1 - HOME_FRAME_EASE) ** (delta * 60);
      h.frame.feetY += (want.feetY - h.frame.feetY) * k;
      h.frame.viewHeight = want.viewHeight;
      h.frame.zoom += (want.zoom - h.frame.zoom) * k;
    }
    body.getWorldPosition(h.feet);
    h.center.copy(h.feet).setY(h.feet.y + herzie.centerHeight);
    const drift =
      Math.sin((time.current / HOME_DRIFT.period) * Math.PI * 2) *
      HOME_DRIFT.angle *
      b;
    homePose(
      h.center,
      h.feet,
      h.azimuth + drift,
      h.frame,
      size.width,
      size.height,
      h.pose,
    );
    // Where the controls put it, and what it looks at (as far ahead as the
    // herzie is).
    h.follow.copy(cam.position);
    cam.getWorldDirection(h.forward);
    h.followTarget
      .copy(h.follow)
      .addScaledVector(h.forward, h.follow.distanceTo(h.center));
    blendPose(
      h.center,
      h.follow,
      h.followTarget,
      h.pose,
      b,
      h.position,
      h.target,
    );
    cam.position.copy(h.position);
    cam.up.set(0, 1, 0);
    cam.lookAt(h.target);
    cam.fov = THREE.MathUtils.lerp(h.fov, h.pose.fov, b);
    const pan = h.pose.pan * b;
    if (Math.abs(pan) > 0.01)
      cam.setViewOffset(
        size.width,
        size.height,
        0,
        pan,
        size.width,
        size.height,
      );
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    h.touched = true;
  }, -0.5);

  return (
    <CameraControls
      ref={controls}
      makeDefault
      minDistance={DISTANCE}
      maxDistance={DISTANCE}
      // Polar angle is from straight up: keep between a high three-quarter
      // view and just above the ground.
      minPolarAngle={WALK_POLAR.min}
      maxPolarAngle={WALK_POLAR.max}
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
