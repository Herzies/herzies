import { VIEW_CAMERA_DISTANCE, VIEW_FRAME_HEIGHT } from "@herzies/shared/gl";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  blendPose,
  type HomePose,
  homeAzimuth,
  homePose,
  lerpAngle,
} from "./homeCamera";

const pose = (): HomePose => ({
  position: new THREE.Vector3(),
  target: new THREE.Vector3(),
  fov: 0,
  pan: 0,
});

describe("homePose", () => {
  const center = new THREE.Vector3(3, 1.2, -4);
  const feet = new THREE.Vector3(3, 0, -4);
  const frame = { feetY: 400, viewHeight: 300, zoom: 1 };

  it("stands Home's distance from the herzie's middle, looking at it", () => {
    const p = homePose(center, feet, 0.5, frame, 380, 600, pose());
    expect(p.position.distanceTo(center)).toBeCloseTo(VIEW_CAMERA_DISTANCE, 5);
    expect(p.target.equals(center)).toBe(true);
  });

  it("draws the herzie as big as Home's box did, on any canvas", () => {
    for (const height of [520, 700, 900]) {
      const p = homePose(center, feet, 0, frame, 380, height, pose());
      // World units per px at the herzie's middle, on the canvas...
      const perPx =
        (2 *
          VIEW_CAMERA_DISTANCE *
          Math.tan(THREE.MathUtils.degToRad(p.fov / 2))) /
        height;
      // ...as in Home's box.
      expect(perPx).toBeCloseTo(VIEW_FRAME_HEIGHT / frame.viewHeight, 6);
    }
  });

  it("zooming out widens the lens", () => {
    const near = homePose(center, feet, 0, frame, 380, 600, pose());
    const far = homePose(
      center,
      feet,
      0,
      { ...frame, zoom: 0.8 },
      380,
      600,
      pose(),
    );
    expect(far.fov).toBeGreaterThan(near.fov);
  });

  it("pans so the feet land where Home stands them", () => {
    const p = homePose(center, feet, 1.1, frame, 380, 600, pose());
    const cam = new THREE.PerspectiveCamera(p.fov, 380 / 600, 0.05, 100);
    cam.position.copy(p.position);
    cam.lookAt(p.target);
    cam.setViewOffset(380, 600, 0, p.pan, 380, 600);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const y = ((1 - feet.clone().project(cam).y) / 2) * 600;
    expect(y).toBeCloseTo(frame.feetY, 3);
  });

  it("stands in front of the herzie", () => {
    const heading = 0.3;
    const p = homePose(
      center,
      feet,
      homeAzimuth(heading),
      frame,
      380,
      600,
      pose(),
    );
    const toCamera = p.position.clone().sub(center).setY(0).normalize();
    const forward = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    expect(toCamera.dot(forward)).toBeGreaterThan(0.9);
  });
});

describe("blendPose", () => {
  it("swings round the herzie, never through it", () => {
    const center = new THREE.Vector3(0, 1, 0);
    const follow = new THREE.Vector3(0, 5, -12);
    const home = homePose(
      center,
      new THREE.Vector3(0, 0, 0),
      0,
      { feetY: 400, viewHeight: 300, zoom: 1 },
      380,
      600,
      pose(),
    );
    const at = new THREE.Vector3();
    const look = new THREE.Vector3();
    const closest = Math.min(VIEW_CAMERA_DISTANCE, follow.distanceTo(center));
    for (let i = 0; i <= 20; i++) {
      blendPose(center, follow, center, home, i / 20, at, look);
      expect(at.distanceTo(center)).toBeGreaterThan(closest - 1e-6);
    }
    blendPose(center, follow, center, home, 1, at, look);
    expect(at.distanceTo(home.position)).toBeLessThan(1e-6);
  });
});

describe("lerpAngle", () => {
  it("goes the short way round", () => {
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(Math.PI, 1);
    expect(lerpAngle(0.1, -0.1, 0.5)).toBeCloseTo(0, 6);
  });
});
