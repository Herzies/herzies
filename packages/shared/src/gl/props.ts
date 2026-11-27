import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import {
  type BeanieProp,
  type FeatherProp,
  featherVane,
  type MoustacheProp,
  type PropModel,
  type ShoeProp,
  type TieProp,
} from "../creature-renderer.js";

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
  if (prop.kind === "necktie") return necktie(prop, paint);
  if (prop.kind === "feather") return feather(prop, paint);
  if (prop.kind === "moustache") return moustache(prop, paint);
  if (prop.kind === "beanie") return beanie(prop, paint);
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
function upperGeometry(r: number, flatY: number): THREE.BufferGeometry {
  return cached(`shoe-upper:${r.toFixed(4)}:${flatY.toFixed(4)}`, () => {
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
      p.setXYZ(i, ux * SHOE_UPPER.rx * r, Math.min(y, flatY), z);
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
    // Polished (style.gloss): all but the matte sole.
    const mesh = new THREE.Mesh(
      geometry,
      paint(color, matte, !matte && style.gloss),
    );
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
  // A loafer has just the one strap.
  for (const z of style.strap ? [-0.8] : [-0.55, -0.85, -1.15]) {
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

/** Rows down a feather's vane. */
const FEATHER_ROWS = 28;
/** Where along it the vane turns the tip's colour. */
const FEATHER_TIP = 0.86;

/**
 * A feather: a quill along a smooth curve through `prop.spine`, and a vane
 * either side of it, flat but folded back a little from the quill so it
 * catches the light like one. The trailing side is narrower than the
 * leading one, and each has a split in it, as a flight feather has. Two
 * sheets, wound opposite ways, so it shows from behind as well.
 */
function feather(prop: FeatherProp, paint: Paint): THREE.Group {
  const group = new THREE.Group();
  const curve = new THREE.CatmullRomCurve3(
    prop.spine.map((p) => new THREE.Vector3(...p)),
  );
  const facing = new THREE.Vector3(...prop.facing).normalize();
  /** A split in the vane, `at` along it: how much of the width is left. */
  const split = (t: number, at: number) =>
    1 - 0.5 * Math.max(0, 1 - Math.abs(t - at) / 0.035);
  // Each row: its left edge, the quill, its right edge.
  const rows: THREE.Vector3[][] = [];
  for (let r = 0; r <= FEATHER_ROWS; r++) {
    const t = r / FEATHER_ROWS;
    const spine = curve.getPoint(t);
    const across = curve.getTangent(t).cross(facing).normalize();
    const w = prop.width * featherVane(t);
    const edge = (side: number, width: number) =>
      spine
        .clone()
        .addScaledVector(across, side * width)
        .addScaledVector(facing, -0.3 * width);
    rows.push([
      edge(-1, w * 0.72 * split(t, 0.5)),
      spine,
      edge(1, w * split(t, 0.64)),
    ]);
  }
  const vane = (from: number, to: number) => {
    const position: number[] = [];
    const normal: number[] = [];
    const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
      // Wound so the front sheet's face looks along `facing`, then the
      // back's the other way.
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      const [p, q] = n.dot(facing) >= 0 ? [b, c] : [c, b];
      for (const v of [a, p, q]) {
        position.push(v.x, v.y, v.z);
        normal.push(facing.x, facing.y, facing.z);
      }
      for (const v of [a, q, p]) {
        position.push(v.x, v.y, v.z);
        normal.push(-facing.x, -facing.y, -facing.z);
      }
    };
    for (let r = from + 1; r <= to; r++) {
      const [l0, s0, r0] = rows[r - 1];
      const [l1, s1, r1] = rows[r];
      tri(l0, s0, l1);
      tri(s0, s1, l1);
      tri(s0, r0, s1);
      tri(r0, r1, s1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
    return g;
  };
  const own: THREE.BufferGeometry[] = [];
  const add = (geometry: THREE.BufferGeometry, color: string) => {
    own.push(geometry);
    const mesh = new THREE.Mesh(geometry, paint(color));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  const tipRow = Math.round(FEATHER_TIP * FEATHER_ROWS);
  add(vane(0, tipRow), prop.colors.vane);
  add(vane(tipRow, FEATHER_ROWS), prop.colors.tip);
  add(
    new THREE.TubeGeometry(curve, FEATHER_ROWS, prop.width * 0.09, 6),
    prop.colors.quill,
  );
  // Its own shapes, unlike the shared ones the other props are cut from:
  // the model frees them (see disposeProp).
  group.userData.geometries = own;
  return group;
}

/**
 * A closed tube through `rings` (each the same number of points round,
 * each a step on from the last), shut at either end by a point if given:
 * wound to face out, its normals smoothed round and along it.
 */
function ringGeometry(
  rings: THREE.Vector3[][],
  start?: THREE.Vector3,
  end?: THREE.Vector3,
): THREE.BufferGeometry {
  const sides = rings[0].length;
  const position: number[] = [];
  for (const ring of rings) for (const p of ring) position.push(p.x, p.y, p.z);
  const startAt = position.length / 3;
  if (start) position.push(start.x, start.y, start.z);
  const endAt = position.length / 3;
  if (end) position.push(end.x, end.y, end.z);
  const index: number[] = [];
  const at = (r: number, k: number) => r * sides + (k % sides);
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let k = 0; k < sides; k++) {
      const a = at(r, k);
      const b = at(r, k + 1);
      const c = at(r + 1, k);
      const d = at(r + 1, k + 1);
      index.push(a, c, b, b, c, d);
    }
  }
  const last = rings.length - 1;
  for (let k = 0; k < sides; k++) {
    if (start) index.push(startAt, at(0, k), at(0, k + 1));
    if (end) index.push(at(last, k), endAt, at(last, k + 1));
  }
  // Facing out, or the other way: judged by a side face against the way
  // out from the middle of its rings.
  const p = new THREE.Vector3(...position.slice(0, 3));
  const q = new THREE.Vector3(...position.slice(sides * 3, sides * 3 + 3));
  const s = new THREE.Vector3(...position.slice(3, 6));
  const face = q.clone().sub(p).cross(s.clone().sub(p));
  const mid = new THREE.Vector3();
  for (const v of rings[0]) mid.add(v);
  mid.divideScalar(sides);
  if (face.dot(p.clone().sub(mid)) < 0) {
    for (let i = 0; i < index.length; i += 3) {
      const t = index[i + 1];
      index[i + 1] = index[i + 2];
      index[i + 2] = t;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Rings along a moustache, and round it. */
const MOUSTACHE_ROWS = 64;
const MOUSTACHE_SIDES = 20;
/** Of its length, how much at either end is its (greyer) tips. */
const MOUSTACHE_TIPS = 0.1;

/**
 * A moustache: one tube along a smooth curve through `prop.spine`, as
 * thick as `prop.radii` along it and drawn out to a point at either tip.
 * Flattened against the face, it's combed into strands (shallow grooves
 * running along it), parted in the middle (a dip in its top), and, unless
 * it's waxed, its lower edge hangs in tufts.
 */
function moustache(prop: MoustacheProp, paint: Paint): THREE.Group {
  const group = new THREE.Group();
  const curve = new THREE.CatmullRomCurve3(
    prop.spine.map((p) => new THREE.Vector3(...p)),
    false,
    "centripetal",
  );
  const n = prop.spine.length - 1;
  /** Between the given points, `t` (0..1) along: which, and how far on. */
  const between = (t: number): [number, number] => {
    const f = t * n;
    const i = Math.min(Math.floor(f), n - 1);
    return [i, f - i];
  };
  const radiusAt = (t: number) => {
    const [i, u] = between(t);
    return prop.radii[i] + (prop.radii[i + 1] - prop.radii[i]) * u;
  };
  const outAt = (t: number) => {
    const [i, u] = between(t);
    return new THREE.Vector3(...prop.normals[i])
      .lerp(new THREE.Vector3(...prop.normals[i + 1]), u)
      .normalize();
  };
  const rings: THREE.Vector3[][] = [];
  const tangents: THREE.Vector3[] = [];
  for (let r = 0; r <= MOUSTACHE_ROWS; r++) {
    const t = r / MOUSTACHE_ROWS;
    const spine = curve.getPoint(t);
    const along = curve.getTangent(t);
    tangents.push(along);
    // Its frame: out of the face, and down it (y is down).
    const out = outAt(t);
    out.addScaledVector(along, -out.dot(along)).normalize();
    const down = along.clone().cross(out).normalize();
    if (down.y < 0) down.negate();
    const radius = radiusAt(t);
    // The parting: a dip in its top, at the middle (a waxed one's combed
    // apart clearly).
    const parting =
      1 -
      (prop.waxed ? 0.45 : 0.2) *
        Math.exp(-(((t - 0.5) / (prop.waxed ? 0.025 : 0.03)) ** 2));
    // Tufts along its lower edge.
    const tuft = 0.55 + 0.45 * Math.cos(t * Math.PI * 2 * 11);
    const ring: THREE.Vector3[] = [];
    for (let k = 0; k < MOUSTACHE_SIDES; k++) {
      const a = (k / MOUSTACHE_SIDES) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      // Strands: shallow grooves running its length. Waxed, it's smoothed
      // flatter against the face.
      const rho =
        radius *
        (1 + (prop.waxed ? 0.025 : 0.05) * Math.cos(a * 10)) *
        (s < 0 ? parting : 1);
      const flat = prop.waxed ? 0.8 : 1;
      const hang = s > 0 && !prop.waxed ? radius * 0.45 * s ** 3 * tuft : 0;
      ring.push(
        spine
          .clone()
          .addScaledVector(out, rho * c * flat)
          .addScaledVector(down, rho * s + hang),
      );
    }
    rings.push(ring);
  }
  // Each tip drawn out to a point past its last ring.
  const tipPoint = (r: number, way: number) =>
    curve
      .getPoint(r / MOUSTACHE_ROWS)
      .addScaledVector(tangents[r], way * radiusAt(r / MOUSTACHE_ROWS) * 1.6);
  const tip = Math.round(MOUSTACHE_TIPS * MOUSTACHE_ROWS);
  const own = [
    ringGeometry(rings.slice(0, tip + 1), tipPoint(0, -1)),
    ringGeometry(rings.slice(tip, MOUSTACHE_ROWS - tip + 1)),
    ringGeometry(
      rings.slice(MOUSTACHE_ROWS - tip),
      undefined,
      tipPoint(MOUSTACHE_ROWS, 1),
    ),
  ];
  for (const [i, geometry] of own.entries()) {
    const mesh = new THREE.Mesh(
      geometry,
      paint(i === 1 ? prop.colors.hair : prop.colors.tips),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.userData.geometries = own;
  return group;
}

/** Rings up a beanie's cuff and crown, and round it. */
const BEANIE_CUFF_ROWS = 10;
const BEANIE_CROWN_ROWS = 22;
const BEANIE_SIDES = 96;
/** Ribs round it (knit two, purl two). */
const BEANIE_RIBS = 16;

/**
 * A knitted watch cap: a cuff turned up round the head, its edges rolled
 * and ribbed (the ribs squared off, as knit ribs are), and above it the
 * crown, smooth and a shade lighter, set in from the cuff's fold and
 * rounded over to its top. Built about the cuff's lower edge (y down: it
 * rises to −y).
 */
function beanie(prop: BeanieProp, paint: Paint): THREE.Group {
  const group = new THREE.Group();
  const R = prop.radius;
  const ring = (height: number, radius: number, ribs: number) => {
    const out: THREE.Vector3[] = [];
    for (let k = 0; k < BEANIE_SIDES; k++) {
      const a = (k / BEANIE_SIDES) * Math.PI * 2;
      // −1..1, flat-topped: a rib, then the furrow beside it.
      const c = Math.cos(a * BEANIE_RIBS);
      const rib = c / (Math.abs(c) + 0.3);
      const rho = radius * (1 + ribs * 0.5 * rib);
      out.push(
        new THREE.Vector3(rho * Math.cos(a), -height, rho * Math.sin(a)),
      );
    }
    return out;
  };
  // The cuff: its lower and upper edges rolled in a little, fullest
  // between them.
  const cuffRings: THREE.Vector3[][] = [];
  for (let r = 0; r <= BEANIE_CUFF_ROWS; r++) {
    const u = r / BEANIE_CUFF_ROWS;
    const roll = Math.sin(Math.PI * u) ** 0.35;
    cuffRings.push(ring(u * prop.cuff, R * (0.97 + 0.08 * roll), 0.09));
  }
  // The crown: up from just inside the cuff's fold, rounded over.
  const crownRings: THREE.Vector3[][] = [];
  for (let r = 0; r <= BEANIE_CROWN_ROWS; r++) {
    const u = (r / BEANIE_CROWN_ROWS) * 0.985;
    const radius = R * 0.94 * (1 - u ** 2.6) ** 0.5;
    crownRings.push(ring(prop.cuff + u * prop.crown, radius, 0));
  }
  const own = [
    ringGeometry(
      cuffRings,
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, -prop.cuff, 0),
    ),
    ringGeometry(
      crownRings,
      new THREE.Vector3(0, -prop.cuff, 0),
      new THREE.Vector3(0, -(prop.cuff + prop.crown), 0),
    ),
  ];
  for (const [i, geometry] of own.entries()) {
    const mesh = new THREE.Mesh(
      geometry,
      paint(i === 0 ? prop.colors.cuff : prop.colors.crown, true),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.userData.geometries = own;
  return group;
}

/** Frees what a prop model built for itself alone (a feather's shapes, a
 * moustache's, a beanie's). */
export function disposeProp(group: THREE.Group): void {
  const own = group.userData.geometries as THREE.BufferGeometry[] | undefined;
  for (const g of own ?? []) g.dispose();
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

/** What a necktie's group carries for the renderer: moves the blade's
 * ribbon to where the simulation has the blade's points. */
export interface TieRibbon {
  update(points: [number, number, number][]): void;
  dispose(): void;
}

/** Cells across the blade's width (the checks). */
const TIE_COLS = 4;

/**
 * Fylling's Necktie: a smooth band round the neck, a knot, and a ribbon
 * blade (a grid of quads, double sided so it shows from behind when it
 * swings out) that `group.userData.ribbon` reshapes each frame (see
 * TieRibbon). The ribbon is cut into cells, about square, and alternate
 * cells use the second material: a check.
 */
function necktie(prop: TieProp, paint: Paint): THREE.Group {
  const group = new THREE.Group();
  const { colors } = prop;
  const add = (
    geometry: THREE.BufferGeometry,
    color: string,
    at: [number, number, number],
    matte = false,
  ) => {
    const mesh = new THREE.Mesh(geometry, paint(color, matte));
    mesh.position.set(...at);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  // The band: a torus lying flat round the neck.
  const band = new THREE.TorusGeometry(
    prop.ringRadius,
    prop.k * 0.55,
    10,
    40,
  ).rotateX(Math.PI / 2);
  add(band, colors.band, [prop.center[0], prop.ringY, prop.center[2]], true);
  // The knot.
  add(
    new THREE.SphereGeometry(1, 20, 14).scale(...prop.knotSize),
    colors.knot,
    prop.knot,
    true,
  );
  // The ribbon's rows: the root's, then each segment cut into as many rows
  // as keeps its cells square (at the segment's width), each lying at `t`
  // of the way along its segment.
  const controls = prop.rig.rest.length + 1;
  const rowsAt: { seg: number; t: number }[] = [{ seg: 0, t: 0 }];
  for (let i = 0; i < controls - 1; i++) {
    const width = prop.halfWidths[i] + prop.halfWidths[i + 1];
    const cell = width / TIE_COLS;
    const n = Math.max(1, Math.min(5, Math.round(prop.rig.lengths[i] / cell)));
    for (let j = 1; j <= n; j++) rowsAt.push({ seg: i, t: j / n });
  }
  const rows = rowsAt.length;
  const perRow = TIE_COLS + 1;
  const sheet = rows * perRow;
  const position = new Float32Array(sheet * 2 * 3);
  const normal = new Float32Array(sheet * 2 * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  // Triangles, grouped by material: the base's cells, then the check's.
  const base: number[] = [];
  const check: number[] = [];
  for (let r = 1; r < rows; r++) {
    for (let c = 0; c < TIE_COLS; c++) {
      const a = (r - 1) * perRow + c;
      const b = a + 1;
      const d0 = r * perRow + c;
      const d1 = d0 + 1;
      const into = (r + c) % 2 === 0 ? base : check;
      // Front sheet, then the back's, wound the other way.
      into.push(a, d0, b, b, d0, d1);
      into.push(
        sheet + a,
        sheet + b,
        sheet + d0,
        sheet + b,
        sheet + d1,
        sheet + d0,
      );
    }
  }
  geometry.setIndex([...base, ...check]);
  geometry.addGroup(0, base.length, 0);
  geometry.addGroup(base.length, check.length, 1);
  const mesh = new THREE.Mesh(geometry, [
    paint(colors.base, true),
    paint(colors.check, true),
  ]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  group.add(mesh);

  const toward = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const centre = new THREE.Vector3(...prop.rig.center);
  // Each control point's frame: where it is, across the blade, the face.
  const at = Array.from({ length: controls }, () => new THREE.Vector3());
  const acrossAt = Array.from({ length: controls }, () => new THREE.Vector3());
  const facingAt = Array.from({ length: controls }, () => new THREE.Vector3());
  const p = new THREE.Vector3();
  const across = new THREE.Vector3();
  const facing = new THREE.Vector3();
  const ribbon: TieRibbon = {
    update(points) {
      const all = [prop.rig.root, ...points];
      for (let i = 0; i < controls; i++) {
        const q = all[i];
        const before = all[Math.max(0, i - 1)];
        const after = all[Math.min(controls - 1, i + 1)];
        tangent
          .set(after[0] - before[0], after[1] - before[1], after[2] - before[2])
          .normalize();
        // Out from the chest, then across the blade, then the sheet's face.
        at[i].set(q[0], q[1], q[2]);
        toward.copy(at[i]).sub(centre).normalize();
        acrossAt[i].crossVectors(tangent, toward);
        if (acrossAt[i].lengthSq() < 1e-8) acrossAt[i].set(1, 0, 0);
        acrossAt[i].normalize();
        facingAt[i].crossVectors(acrossAt[i], tangent).normalize();
        if (facingAt[i].dot(toward) < 0) facingAt[i].negate();
      }
      rowsAt.forEach(({ seg, t }, r) => {
        // Between control points `seg` and `seg + 1` (the root's row is the
        // first control point).
        const i0 = r === 0 ? 0 : seg;
        const i1 = r === 0 ? 0 : seg + 1;
        const k = r === 0 ? 0 : t;
        p.lerpVectors(at[i0], at[i1], k);
        across.lerpVectors(acrossAt[i0], acrossAt[i1], k).normalize();
        facing.lerpVectors(facingAt[i0], facingAt[i1], k).normalize();
        const half =
          prop.halfWidths[i0] + (prop.halfWidths[i1] - prop.halfWidths[i0]) * k;
        for (let c = 0; c < perRow; c++) {
          const side = -1 + (2 * c) / TIE_COLS;
          const v = r * perRow + c;
          const x = p.x + across.x * half * side + facing.x * prop.k * 0.06;
          const y = p.y + across.y * half * side + facing.y * prop.k * 0.06;
          const z = p.z + across.z * half * side + facing.z * prop.k * 0.06;
          position[v * 3] = position[(sheet + v) * 3] = x;
          position[v * 3 + 1] = position[(sheet + v) * 3 + 1] = y;
          position[v * 3 + 2] = position[(sheet + v) * 3 + 2] = z;
          normal.set([facing.x, facing.y, facing.z], v * 3);
          normal.set([-facing.x, -facing.y, -facing.z], (sheet + v) * 3);
        }
      });
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.normal.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      band.dispose();
    },
  };
  ribbon.update(prop.rig.rest);
  group.userData.ribbon = ribbon;
  return group;
}
