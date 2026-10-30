import { DEFAULT_CAMERA_TILT_DEG, DEFAULT_Y_ANGLE } from "@herzies/shared";
import { VIEW_CAMERA_DISTANCE, VIEW_FRAME_HEIGHT } from "@herzies/shared/gl";
import * as THREE from "three";
import type { HomeFrame } from "./homeMode";

/**
 * Where the camera stands at Home, and how it swings there from behind the
 * herzie: the pure part, so it's tested without a scene.
 *
 * Home's camera is the one Home always had (HerzieView's): in front of the
 * herzie, a little to its side (the herzie turned DEFAULT_Y_ANGLE away),
 * tilted down a touch, at the same distance and with the same lens — so
 * the herzie looks exactly as it did, with its feet where they stood. The
 * lens is widened for the Town's canvas, which is the whole window rather
 * than Home's box (`frame.viewHeight` tall).
 */

export type HomePose = {
  position: THREE.Vector3;
  /** What it looks at: the herzie's middle. */
  target: THREE.Vector3;
  /** Vertical field of view, degrees. */
  fov: number;
  /** How far the picture is panned down (px; see setViewOffset), so the
   * feet land at `frame.feetY`. */
  pan: number;
};

const scratch = new THREE.PerspectiveCamera();
const feetScratch = new THREE.Vector3();

/**
 * Home's camera pose for a herzie whose middle is `center` and whose feet
 * are at `feet`, facing `azimuth` (the camera's azimuth round it, see
 * homeAzimuth), on a `width` x `height` px canvas.
 */
export function homePose(
  center: THREE.Vector3,
  feet: THREE.Vector3,
  azimuth: number,
  frame: HomeFrame,
  width: number,
  height: number,
  out: HomePose,
): HomePose {
  const tilt = THREE.MathUtils.degToRad(DEFAULT_CAMERA_TILT_DEG);
  const dist = VIEW_CAMERA_DISTANCE;
  out.position.set(
    center.x + Math.sin(azimuth) * Math.cos(tilt) * dist,
    center.y + Math.sin(tilt) * dist,
    center.z + Math.cos(azimuth) * Math.cos(tilt) * dist,
  );
  out.target.copy(center);
  // HerzieView's lens: VIEW_FRAME_HEIGHT / zoom tall at the herzie's middle,
  // across its box; across the whole canvas, as many px per world unit.
  const half = VIEW_FRAME_HEIGHT / Math.max(0.05, frame.zoom) / 2 / dist;
  const tanHalf = (half * height) / Math.max(1, frame.viewHeight);
  out.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanHalf));
  // Where the feet land with no pan, and so how far to pan.
  scratch.fov = out.fov;
  scratch.aspect = width / Math.max(1, height);
  scratch.near = 0.05;
  scratch.far = 100;
  scratch.position.copy(out.position);
  scratch.up.set(0, 1, 0);
  scratch.lookAt(out.target);
  scratch.clearViewOffset();
  scratch.updateProjectionMatrix();
  scratch.updateMatrixWorld();
  const feetPx = ((1 - feetScratch.copy(feet).project(scratch).y) / 2) * height;
  out.pan = feetPx - frame.feetY;
  return out;
}

/** Home's camera azimuth for a herzie facing `heading`: in front of it,
 * the herzie turned a little aside, as Home always showed it (HerzieView
 * turns the herzie -DEFAULT_Y_ANGLE from a camera on +z). */
export function homeAzimuth(heading: number): number {
  return heading + DEFAULT_Y_ANGLE;
}

/** `a` to `b` the short way round, `t` of the way. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

const spherical = new THREE.Spherical();
const sphericalHome = new THREE.Spherical();
const offset = new THREE.Vector3();

/**
 * The camera `t` of the way from where it follows the herzie (`follow`,
 * looking at `followTarget`) to Home's pose: it swings round the herzie's
 * middle (`center`) — round, not through it — closing in as it goes, and
 * keeps the herzie in the middle of the picture the whole way.
 */
export function blendPose(
  center: THREE.Vector3,
  follow: THREE.Vector3,
  followTarget: THREE.Vector3,
  home: HomePose,
  t: number,
  outPosition: THREE.Vector3,
  outTarget: THREE.Vector3,
): void {
  spherical.setFromVector3(offset.copy(follow).sub(center));
  sphericalHome.setFromVector3(offset.copy(home.position).sub(center));
  const radius = THREE.MathUtils.lerp(
    spherical.radius,
    sphericalHome.radius,
    t,
  );
  const phi = THREE.MathUtils.lerp(spherical.phi, sphericalHome.phi, t);
  const theta = lerpAngle(spherical.theta, sphericalHome.theta, t);
  outPosition.setFromSphericalCoords(radius, phi, theta).add(center);
  outTarget.lerpVectors(followTarget, home.target, t);
}
