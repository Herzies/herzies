import { DEFAULT_CAMERA_DISTANCE, SH } from "@herzies/shared";
import { MODEL_SCALE, studioLighting } from "@herzies/shared/gl";
import * as THREE from "three";

// How every herzie island on the about page is framed, so the scenes line
// up with each other whether HerzieView draws them or CollectScene does.

/** Pulled back to take in its island: the tree behind, the earth below. */
export const ISLAND_ZOOM = 0.62;
/** The camera pulled back and looking down a little, as the Town's does,
 * so the island reads as a place and its near edge doesn't loom. */
export const ISLAND_DISTANCE = 5;
export const ISLAND_TILT = 22;
/** Its box: wide enough for the whole island. */
export const ISLAND_COLS = 140;
/** The ground this far up the box (a share of its height), over the
 * island's clod of earth. */
export const ISLAND_GROUND = 0.44;

/** The box an island is drawn in, for a given cell size (HerzieView's own
 * metrics). */
export function islandBox(size: number) {
  return {
    width: Math.ceil(ISLAND_COLS * size * 0.6),
    height: Math.ceil(SH * size * 1.35),
  };
}

/** The old renderer's frame at the herzie's centre (see HerzieView), and
 * the island camera's distance. */
const FRAME_HEIGHT = 4.5;
const CAMERA_DISTANCE = DEFAULT_CAMERA_DISTANCE * MODEL_SCALE * ISLAND_DISTANCE;
const TARGET_Y = 0.9;
const scratch = new THREE.Vector3();

/** Frames `cam` on an island, as HerzieView frames an island herzie:
 * pulled back, looking down a little, the ground `groundInset` px above the
 * box's bottom. For scenes drawn straight on the herzie stage. */
export function frameIslandCamera(
  cam: THREE.PerspectiveCamera,
  w: number,
  h: number,
  groundInset: number,
) {
  const frame = FRAME_HEIGHT / ISLAND_ZOOM;
  const tilt = THREE.MathUtils.degToRad(ISLAND_TILT);
  cam.fov = THREE.MathUtils.radToDeg(
    2 * Math.atan(frame / 2 / CAMERA_DISTANCE),
  );
  cam.aspect = w / h;
  cam.position.set(
    0,
    TARGET_Y + CAMERA_DISTANCE * Math.sin(tilt),
    CAMERA_DISTANCE * Math.cos(tilt),
  );
  cam.lookAt(0, TARGET_Y, 0);
  cam.clearViewOffset();
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  const groundPx = ((1 - scratch.set(0, 0, 0).project(cam).y) / 2) * h;
  const pan = groundPx - (h - groundInset);
  if (pan !== 0) cam.setViewOffset(w, h, 0, pan, w, h);
  cam.updateProjectionMatrix();
}

/** The studio sun HerzieView lights its islands with, for scenes drawn
 * straight on the stage. */
export function islandSun(): THREE.DirectionalLight {
  const sun = new THREE.DirectionalLight("#ffffff", 1);
  sun.position.copy(studioLighting.uSun.value).multiplyScalar(10);
  return sun;
}
