import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { PropModel, ShoeProp } from "../creature-renderer.js";

/**
 * Props the 3D renderer builds as models of their own, where the ray caster
 * makes do with spheres (see Sphere.prop): built in creature space (y down,
 * the front facing the camera at −z), about their middle, unturned — the
 * caller places and turns the group. `paint` gives the material for a
 * colour, so they're shaded as the herzie is; `matte`, with only a faint
 * highlight (a flat dark face turned to the light would otherwise go grey
 * all over); `gloss`, polished (finish "gloss": a hard highlight and a
 * bright rim).
 */
export type Paint = (
  color: string,
  matte?: boolean,
  gloss?: boolean,
) => THREE.Material;

export function buildPropModel(prop: PropModel, paint: Paint): THREE.Group {
  if (prop.kind === "shoe") return shoe(prop, paint);
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

/** A unit sphere squashed to an ellipsoid: scaled in the geometry, so its
 * normals stay true for the bands (a scaled mesh would skew them). */
function ellipsoid(rx: number, ry: number, rz: number): THREE.BufferGeometry {
  return cached(
    `ellipsoid:${rx.toFixed(4)}:${ry.toFixed(4)}:${rz.toFixed(4)}`,
    () => new THREE.SphereGeometry(1, 32, 20).scale(rx, ry, rz),
  );
}

/** A flat-ended elliptical slab, `h` tall, `w` by `d` across: a sole. */
function slab(w: number, h: number, d: number): THREE.BufferGeometry {
  return cached(`slab:${w.toFixed(4)}:${h.toFixed(4)}:${d.toFixed(4)}`, () =>
    new THREE.CylinderGeometry(1, 1, h, 40, 1).scale(w / 2, 1, d / 2),
  );
}

/** How a shoe's upper is shaped, in units of the leg's radius: roomy
 * enough that the foot stays inside through a stride, which moves it a
 * little within the shoe. */
export const SHOE_UPPER = {
  /** Half-width, half-height and half-length of the ellipsoid it's cut
   * from, and where that sits (from the shoe's middle; y down, toe −z). */
  rx: 1.17,
  ry: 0.8,
  rz: 1.55,
  y: -0.12,
  z: -0.2,
  /** How far its top drops toward the toe. */
  toeDrop: 0.5,
};

/**
 * A sneaker's upper, sized by the leg's radius `r`: an ellipsoid, its top
 * sloping down toward the toe and its bottom cut flat at `flatY` (y down),
 * so it sits square in the sole rather than balancing on a curve.
 */
function upperGeometry(
  r: number,
  flatY: number,
  /** Cut flat across the top here too (y down), for a low shoe: the
   * loafer's topline. */
  topY = Number.NEGATIVE_INFINITY,
): THREE.BufferGeometry {
  const key = `shoe-upper:${r.toFixed(4)}:${flatY.toFixed(4)}:${topY.toFixed(4)}`;
  return cached(key, () => {
    const g = new THREE.SphereGeometry(1, 40, 24);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const ux = p.getX(i);
      const uy = p.getY(i);
      const uz = p.getZ(i);
      let y = (SHOE_UPPER.y + uy * SHOE_UPPER.ry) * r;
      const z = (SHOE_UPPER.z + uz * SHOE_UPPER.rz) * r;
      // The top half drops toward the toe (−z): high at the heel and the
      // ankle, low over the toes.
      if (uy < 0) {
        const toward = Math.max(0, -uz);
        y += SHOE_UPPER.toeDrop * r * toward * toward * -uy;
      }
      p.setXYZ(
        i,
        ux * SHOE_UPPER.rx * r,
        Math.max(topY, Math.min(y, flatY)),
        z,
      );
    }
    g.computeVertexNormals();
    return g;
  });
}

/**
 * A sneaker round its foot, sized by the leg's radius `r` (built about the
 * shoe's middle, y down, toe at −z; its bottom at +r/2 is the leg's):
 *
 * - the upper, wide enough at the leg's middle to hide the foot (the leg
 *   comes up out of it), sloping down to the toe, flat underneath;
 * - a toe cap over its front, a shade of its own;
 * - a sole the shape of its footprint and a little larger, with a stripe
 *   round its top edge;
 * - laces across the instep, a cuff round the ankle where the leg comes
 *   out, and a tab up the heel.
 *
 * Smooth shapes, so the bands sweep across them as across the herzie.
 */
function shoe(prop: ShoeProp, paint: Paint): THREE.Group {
  const { style } = prop;
  if (style.cut === "loafer") return loafer(prop, paint);
  // Built at a leg radius of 1 and scaled to the leg (uniformly, so the
  // normals hold): one set of shapes for every herzie's shoes.
  const r = 1;
  const group = new THREE.Group();
  group.scale.setScalar(prop.r);
  const add = (
    geometry: THREE.BufferGeometry,
    color: string,
    matte = false,
  ) => {
    const mesh = new THREE.Mesh(geometry, paint(color, matte));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const bottom = r * 0.5;
  const soleH = r * 0.24;
  const soleTop = bottom - soleH;
  // The upper, cut flat a little way into the sole.
  const flatY = soleTop + soleH * 0.4;
  add(upperGeometry(r, flatY), style.upper);
  // Its footprint there: the ellipse the cut leaves.
  const cut = ((flatY / r - SHOE_UPPER.y) / SHOE_UPPER.ry) ** 2;
  const across = Math.sqrt(Math.max(0, 1 - cut));
  const footW = 2 * SHOE_UPPER.rx * r * across;
  const footD = 2 * SHOE_UPPER.rz * r * across;
  // The sole: that footprint and a lip beyond it, its bottom the leg's.
  const lip = r * 0.1;
  const soleW = footW + 2 * lip;
  const soleD = footD + 2 * lip;
  const soleZ = SHOE_UPPER.z * r;
  add(slab(soleW, soleH, soleD), style.sole, true).position.set(
    0,
    bottom - soleH / 2,
    soleZ,
  );
  // The stripe round its top edge.
  const stripeH = r * 0.08;
  add(
    slab(soleW + r * 0.03, stripeH, soleD + r * 0.03),
    style.stripe,
  ).position.set(0, soleTop + stripeH / 2, soleZ);
  // The toe cap: over the front of the upper, low.
  add(ellipsoid(r * 0.92, r * 0.36, r * 0.62), style.toe).position.set(
    0,
    soleTop - r * 0.12,
    soleZ - footD / 2 + r * 0.5,
  );
  // Where the upper's top is at `z` (x = 0), as the deformation leaves it.
  const topAt = (z: number) => {
    const uz = (z / r - SHOE_UPPER.z) / SHOE_UPPER.rz;
    const uy = -Math.sqrt(Math.max(0, 1 - uz * uz));
    const toward = Math.max(0, -uz);
    return (
      (SHOE_UPPER.y + uy * SHOE_UPPER.ry) * r +
      SHOE_UPPER.toeDrop * r * toward * toward * -uy
    );
  };
  // Laces: three short bars across the instep, just proud of the upper.
  const lace = cached(`shoe-lace:${r.toFixed(4)}`, () =>
    new THREE.CapsuleGeometry(r * 0.075, r * 0.55, 4, 8).rotateZ(Math.PI / 2),
  );
  for (const z of [-0.55, -0.85, -1.15]) {
    add(lace, style.laces).position.set(0, topAt(z * r) - r * 0.02, z * r);
  }
  // The cuff: a ring round the leg where it comes up out of the upper.
  const [lx, ly, lz] = prop.leg.map((v) => v / prop.r);
  const cuffY = -r * 0.62;
  const legHalf = Math.sqrt(Math.max(0, r * r - (cuffY - ly) ** 2));
  add(
    cached(`shoe-cuff:${r.toFixed(4)}:${legHalf.toFixed(4)}`, () =>
      new THREE.TorusGeometry(legHalf + r * 0.03, r * 0.12, 10, 32).rotateX(
        Math.PI / 2,
      ),
    ),
    style.collar,
  ).position.set(lx, cuffY, lz);
  // The heel tab, up the back of the cuff.
  add(
    cached(
      `shoe-tab:${r.toFixed(4)}`,
      () => new RoundedBoxGeometry(r * 0.36, r * 0.5, r * 0.14, 2, r * 0.06),
    ),
    style.tab,
  ).position.set(lx, cuffY - r * 0.06, lz + legHalf + r * 0.08);
  return group;
}

/**
 * A loafer round its foot, built like the sneaker (see `shoe`), but cut
 * low and slipped on: the upper sliced flat at a low topline, a thin rolled
 * edge round the opening where the leg comes out, a penny strap across the
 * instep with its slot, and a thin sole with a heel block under the back.
 * No laces, no cuff, no tab. With `style.gloss`, all the leather is
 * polished.
 */
function loafer(prop: ShoeProp, paint: Paint): THREE.Group {
  const { style } = prop;
  const r = 1;
  const gloss = !!style.gloss;
  const group = new THREE.Group();
  group.scale.setScalar(prop.r);
  const add = (
    geometry: THREE.BufferGeometry,
    color: string,
    matte = false,
    shiny = gloss,
  ) => {
    const mesh = new THREE.Mesh(geometry, paint(color, matte, shiny));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const bottom = r * 0.5;
  const soleH = r * 0.16;
  const soleTop = bottom - soleH;
  const flatY = soleTop + soleH * 0.4;
  // Low: the topline at the leg's middle, so the leg shows well above it.
  const [lx, ly, lz] = prop.leg.map((v) => v / prop.r);
  const topY = ly + r * 0.08;
  add(upperGeometry(r, flatY, topY), style.upper);
  const cut = ((flatY / r - SHOE_UPPER.y) / SHOE_UPPER.ry) ** 2;
  const across = Math.sqrt(Math.max(0, 1 - cut));
  const footW = 2 * SHOE_UPPER.rx * r * across;
  const footD = 2 * SHOE_UPPER.rz * r * across;
  const lip = r * 0.06;
  const soleW = footW + 2 * lip;
  const soleD = footD + 2 * lip;
  const soleZ = SHOE_UPPER.z * r;
  // The sole, thin, and a heel block under the back of it.
  add(slab(soleW, soleH, soleD), style.sole, true, false).position.set(
    0,
    bottom - soleH / 2,
    soleZ,
  );
  // Where the upper's top is at `z` (x = 0), as the deformation leaves it.
  const topAt = (z: number) => {
    const uz = (z / r - SHOE_UPPER.z) / SHOE_UPPER.rz;
    const uy = -Math.sqrt(Math.max(0, 1 - uz * uz));
    const toward = Math.max(0, -uz);
    const y =
      (SHOE_UPPER.y + uy * SHOE_UPPER.ry) * r +
      SHOE_UPPER.toeDrop * r * toward * toward * -uy;
    return Math.max(topY, y);
  };
  // The rolled edge round the opening, just outside the leg.
  const legHalf = Math.sqrt(Math.max(0, r * r - (topY - ly) ** 2));
  add(
    cached(`loafer-topline:${legHalf.toFixed(4)}`, () =>
      new THREE.TorusGeometry(legHalf + r * 0.04, r * 0.07, 8, 32).rotateX(
        Math.PI / 2,
      ),
    ),
    style.collar,
  ).position.set(lx, topY, lz);
  // The penny strap: a flat band across the instep, in front of the
  // opening, and the dark slot cut in its middle.
  const strapZ = lz - legHalf - r * 0.22;
  const strapY = topAt(strapZ) - r * 0.03;
  add(
    cached(
      "loafer-strap",
      () => new RoundedBoxGeometry(r * 1.55, r * 0.12, r * 0.32, 2, r * 0.05),
    ),
    style.laces,
  ).position.set(0, strapY, strapZ);
  add(
    cached(
      "loafer-slot",
      () => new RoundedBoxGeometry(r * 0.42, r * 0.06, r * 0.1, 2, r * 0.03),
    ),
    style.sole,
    true,
    false,
  ).position.set(0, strapY - r * 0.05, strapZ);
  return group;
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
