import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { PropModel } from "../creature-renderer.js";

/**
 * Props the 3D renderer builds as models of their own, where the ray caster
 * makes do with spheres (see Sphere.prop): built in creature space (y down,
 * the front facing the camera at −z), about their middle, unturned — the
 * caller places and turns the group. `paint` gives the material for a
 * colour, so they're shaded as the herzie is; `matte`, with only a faint
 * highlight (a flat dark face turned to the light would otherwise go grey
 * all over).
 */
export type Paint = (color: string, matte?: boolean) => THREE.Material;

export function buildPropModel(prop: PropModel, paint: Paint): THREE.Group {
  return boombox(prop.size, prop.mirrored ? -1 : 1, paint);
}

const BODY = "#aeb4ba";
const TRIM = "#8c939a";
const GRILLE = "#141414";
const CONE = "#5a5a5a";
const DARK = "#2b2b2b";
const WINDOW = "#6f7a86";
const PLAY = "#ffd43b";
const RECORD = "#e0564f";
const ANTENNA = "#d4d8dc";

const geometries = new Map<string, THREE.BufferGeometry>();
function cached(key: string, make: () => THREE.BufferGeometry) {
  let g = geometries.get(key);
  if (!g) {
    g = make();
    geometries.set(key, g);
  }
  return g;
}

/** Cylinder geometry lying along z (three's run along y). */
function alongZ(make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  const g = make();
  g.rotateX(Math.PI / 2);
  return g;
}

/**
 * A boombox: a rounded silver body, a speaker either side (a dark ring
 * with a grey cone in it), a cassette window between them, buttons along
 * the top, a carry handle arching over it and an antenna up off one
 * corner.
 */
function boombox(
  [w, h, d]: [number, number, number],
  /** Which end the antenna's at (−1: mirrored). */
  flip: number,
  paint: Paint,
): THREE.Group {
  const group = new THREE.Group();
  const key = `${w.toFixed(4)}:${h.toFixed(4)}:${d.toFixed(4)}`;
  const add = (
    geometry: THREE.BufferGeometry,
    color: string,
    x: number,
    y: number,
    z: number,
    matte = false,
  ) => {
    const mesh = new THREE.Mesh(geometry, paint(color, matte));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  // y is down: the top is at −h/2, the front at −d/2.
  const top = -h / 2;
  const front = -d / 2;

  group.userData.body = add(
    cached(
      `boombox-body:${key}`,
      () => new RoundedBoxGeometry(w, h, d, 3, Math.min(h, d) * 0.16),
    ),
    BODY,
    0,
    0,
    0,
  );
  // A band of trim round its middle, a touch proud of the body.
  add(
    cached(
      `boombox-trim:${key}`,
      () => new RoundedBoxGeometry(w * 1.01, h * 0.1, d * 1.03, 2, h * 0.04),
    ),
    TRIM,
    0,
    h * 0.36,
    0,
  );

  // The speakers.
  const r = h * 0.36;
  const ring = cached(`boombox-ring:${key}`, () =>
    alongZ(() => new THREE.CylinderGeometry(r, r, d * 0.12, 20)),
  );
  // Its point toward the back, its mouth out the front.
  const cone = cached(`boombox-cone:${key}`, () =>
    alongZ(() => new THREE.CylinderGeometry(r * 0.15, r * 0.5, d * 0.1, 20)),
  );
  const cap = cached(
    `boombox-cap:${key}`,
    () => new THREE.SphereGeometry(r * 0.16, 12, 8),
  );
  for (const side of [-1, 1]) {
    const x = side * w * 0.3;
    add(ring, GRILLE, x, h * 0.04, front - d * 0.02, true);
    add(cone, CONE, x, h * 0.04, front - d * 0.06);
    add(cap, DARK, x, h * 0.04, front - d * 0.1);
  }

  // The cassette deck between them: a dark door with a window in it.
  add(
    cached(
      `boombox-deck:${key}`,
      () => new RoundedBoxGeometry(w * 0.2, h * 0.42, d * 0.08, 2, h * 0.03),
    ),
    DARK,
    0,
    h * 0.06,
    front - d * 0.02,
    true,
  );
  add(
    cached(
      `boombox-window:${key}`,
      () => new THREE.BoxGeometry(w * 0.13, h * 0.12, d * 0.04),
    ),
    WINDOW,
    0,
    h * 0.02,
    front - d * 0.06,
  );

  // Buttons along the top, toward the front: play, record, and two more.
  const button = cached(
    `boombox-button:${key}`,
    () => new THREE.BoxGeometry(w * 0.045, h * 0.07, d * 0.18),
  );
  [PLAY, RECORD, DARK, DARK].forEach((color, i) => {
    add(button, color, (i - 1.5) * w * 0.06, top - h * 0.02, front + d * 0.2);
  });

  // The carry handle: half a ring standing up off the top.
  const handle = add(
    cached(
      `boombox-handle:${key}`,
      () => new THREE.TorusGeometry(w * 0.3, h * 0.09, 8, 20, Math.PI),
    ),
    DARK,
    0,
    top,
    d * 0.1,
  );
  // Up is −y here: turned over, the arch rises. Folded down flat (see
  // foldHandle) when something sits on it.
  handle.rotation.z = Math.PI;
  group.userData.handle = handle;

  // The antenna, leaning back off the far corner.
  const length = w * 0.42;
  const antenna = add(
    cached(
      `boombox-antenna:${key}`,
      () => new THREE.CylinderGeometry(h * 0.045, h * 0.055, length, 6),
    ),
    ANTENNA,
    0,
    0,
    0,
  );
  const lean = new THREE.Vector3(0.35 * flip, -1, 0.3).normalize();
  antenna.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), lean);
  antenna.position
    .set(w * 0.4 * flip, top, d * 0.25)
    .addScaledVector(lean, length / 2);

  return group;
}

/** Folds a prop's carry handle down flat on its top (1) or stands it up
 * (0): a cat sits there. */
export function foldHandle(group: THREE.Group, fold: number): void {
  const handle = group.userData.handle as THREE.Object3D | undefined;
  if (handle) handle.rotation.x = -fold * (Math.PI / 2);
}

/** The world box a prop's body fills (not its handle or antenna), or null
 * if it has none. */
export function propBodyBox(
  group: THREE.Group,
  out: THREE.Box3,
): THREE.Box3 | null {
  const body = group.userData.body as THREE.Object3D | undefined;
  if (!body) return null;
  body.updateWorldMatrix(true, false);
  return out.setFromObject(body);
}
