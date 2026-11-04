import * as THREE from "three";
import { type ColorTriplet, primitiveShading } from "../creature-renderer.js";
import {
  CAT_LENGTH,
  type CatState,
  catPounce,
  envelope,
  pounceCrouch,
  pounceLift,
  CAT_TIMING as T,
  TAIL_SEGMENTS,
} from "./cat.js";
import {
  type HerzieLighting,
  herzieMaterial,
  type SchemeUniforms,
} from "./herzieMaterial.js";

/*
 * Sleptwell's body: a white cat with orange markings, built for the way it
 * moves rather than from the herzie's spheres. One skinned mesh is its torso
 * and tail, so the spine can arch, stretch and curl and the tail bends
 * smoothly; its head, ears and legs are rigid pieces on top. Shaded with the
 * herzies' own material (their bands, sun and lamps), so it sits in the
 * Town as one of them.
 *
 * Modelled in world units at size 1 (CAT_LENGTH nose to rump), facing +z,
 * feet on y = 0.
 */

const WHITE = "#FFF6EC";
const ORANGE = "#F0913A";
const PINK = "#E89A9A";
const EYE = "#2A1E1A";

/** The body's height at its middle, standing. */
const BODY_Y = 0.42;
/** Bones' rest places along the body (z), standing. */
const HIPS_Z = -0.22;
const SPINE_Z = 0;
const CHEST_Z = 0.18;
const TAIL_ROOT_Z = -0.4;
const TAIL_ROOT_Y = 0.075;
const TAIL_STEP = 0.12;
/** Its torso, rump to chest, and its girth. */
const TORSO_BACK = -0.44;
const TORSO_FRONT = 0.37;
/** The neck, off the chest bone: where the head turns. */
const NECK: [number, number, number] = [0, 0.1, 0.13];
/** Legs: where each hangs from (its bone's space), and its two lengths. */
type LegSpec = {
  bone: "chest" | "hips";
  at: [number, number, number];
  upper: number;
  lower: number;
  upperRadius: number;
  lowerRadius: number;
  /** +1: the knee bends forward (hind legs), −1: back (forelegs). */
  knee: number;
  /** Its offset in the gait (walk, trot), a fraction of the cycle. */
  walk: number;
  trot: number;
};
const LEGS: LegSpec[] = [
  // Fore left, fore right, hind left, hind right. Walk: a lateral sequence
  // (hind left, fore left, hind right, fore right); trot: diagonal pairs.
  {
    bone: "chest",
    at: [0.075, -0.07, 0.03],
    upper: 0.18,
    lower: 0.18,
    upperRadius: 0.05,
    lowerRadius: 0.04,
    knee: -1,
    walk: 0.25,
    trot: 0,
  },
  {
    bone: "chest",
    at: [-0.075, -0.07, 0.03],
    upper: 0.18,
    lower: 0.18,
    upperRadius: 0.05,
    lowerRadius: 0.04,
    knee: -1,
    walk: 0.75,
    trot: 0.5,
  },
  {
    bone: "hips",
    at: [0.08, -0.04, -0.06],
    upper: 0.2,
    lower: 0.2,
    upperRadius: 0.068,
    lowerRadius: 0.04,
    knee: 1,
    walk: 0,
    trot: 0.5,
  },
  {
    bone: "hips",
    at: [-0.08, -0.04, -0.06],
    upper: 0.2,
    lower: 0.2,
    upperRadius: 0.068,
    lowerRadius: 0.04,
    knee: 1,
    walk: 0.5,
    trot: 0,
  },
];
const PAW_Y = 0.032;

// --- Geometry (built once, shared by every cat) -----------------------------

/** Rings round a path along −z/+z: one closed tube with rounded ends, its
 * skin weights by where each ring sits. */
type Tube = {
  positions: number[];
  normals: number[];
  patch: number[];
  skinIndex: number[];
  skinWeight: number[];
  index: number[];
};

const RADIAL = 18;

function addTube(
  tube: Tube,
  /** Ring stations, back to front: z, centre y, half width, half height. */
  rings: [number, number, number, number][],
  coat: (z: number, angle: number, ring: number) => number,
  skin: (z: number) => [number, number, number, number],
) {
  const base = tube.positions.length / 3;
  for (let r = 0; r < rings.length; r++) {
    const [z, cy, rx, ry] = rings[r];
    // Its slope along the path, for the normals.
    const prev = rings[Math.max(0, r - 1)];
    const next = rings[Math.min(rings.length - 1, r + 1)];
    const dz = next[0] - prev[0] || 1e-6;
    const drx = (next[2] - prev[2]) / dz;
    const dry = (next[3] - prev[3]) / dz;
    const [b0, w0, b1, w1] = skin(z);
    for (let i = 0; i < RADIAL; i++) {
      // Angle from the top, round to its left (+x).
      const a = (i / RADIAL) * Math.PI * 2;
      const sx = Math.sin(a);
      const cy2 = Math.cos(a);
      tube.positions.push(rx * sx, cy + ry * cy2, z);
      const nx = sx / Math.max(rx, 1e-4);
      const ny = cy2 / Math.max(ry, 1e-4);
      const nz = -(drx * Math.abs(sx) + dry * Math.abs(cy2));
      const l = Math.hypot(nx, ny, nz) || 1;
      tube.normals.push(nx / l, ny / l, nz / l);
      tube.patch.push(coat(z, a, r));
      tube.skinIndex.push(b0, b1, 0, 0);
      tube.skinWeight.push(w0, w1, 0, 0);
    }
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < RADIAL; i++) {
      const a = base + r * RADIAL + i;
      const b = base + r * RADIAL + ((i + 1) % RADIAL);
      const c = a + RADIAL;
      const d = b + RADIAL;
      tube.index.push(a, c, b, b, c, d);
    }
  }
}

/** Stations for a round-ended tube from `back` to `front`, its half width
 * and height along it given by `girth` (0..1 along), the ends closed by a
 * smooth cap. */
function stations(
  back: number,
  front: number,
  count: number,
  centreY: (u: number) => number,
  girth: (u: number) => [number, number],
): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let i = 0; i <= count; i++) {
    // Packed toward the ends, where the caps curve.
    const t = i / count;
    const u = 0.5 - 0.5 * Math.cos(t * Math.PI);
    const cap = Math.sqrt(Math.max(0, 1 - Math.abs(2 * u - 1) ** 5));
    const [rx, ry] = girth(u);
    out.push([back + (front - back) * u, centreY(u), rx * cap, ry * cap]);
  }
  return out;
}

/** Bone indices in the skeleton. */
const BONE_HIPS = 0;
const BONE_SPINE = 1;
const BONE_CHEST = 2;
const BONE_TAIL = 3;

/** Two bones blended across a joint at `at`, over `width` either side. */
function across(
  z: number,
  at: number,
  width: number,
  behind: number,
  ahead: number,
): [number, number, number, number] {
  const w = THREE.MathUtils.smoothstep(z, at - width, at + width);
  return [behind, 1 - w, ahead, w];
}

let bodyGeometry: THREE.BufferGeometry | null = null;

/** The torso and tail as one skinned geometry. */
function catBodyGeometry(): THREE.BufferGeometry {
  if (bodyGeometry) return bodyGeometry;
  const tube: Tube = {
    positions: [],
    normals: [],
    patch: [],
    skinIndex: [],
    skinWeight: [],
    index: [],
  };
  // Torso: a soft loaf, fuller at the rump and chest, a little narrower
  // than it is tall; its back a touch higher toward the shoulders.
  const torso = stations(
    TORSO_BACK,
    TORSO_FRONT,
    26,
    (u) => BODY_Y + 0.015 * Math.sin(u * Math.PI),
    (u) => {
      const r =
        0.15 +
        0.018 * Math.exp(-(((u - 0.18) / 0.16) ** 2)) +
        0.014 * Math.exp(-(((u - 0.78) / 0.14) ** 2));
      return [r * 0.9, r];
    },
  );
  addTube(
    tube,
    torso,
    (z, a) => {
      // An orange saddle over the back, ragged at its edge, the chest and
      // belly white.
      const up = Math.cos(a);
      const edge =
        0.05 + 0.18 * Math.sin(z * 11 + 0.6) + 0.1 * Math.sin(z * 23 + 2.1);
      const front = THREE.MathUtils.smoothstep(z, 0.12, 0.3);
      return up > edge + front * 0.75 ? 1 : 0;
    },
    (z) =>
      z < (HIPS_Z + SPINE_Z) / 2
        ? across(z, HIPS_Z + 0.1, 0.08, BONE_HIPS, BONE_SPINE)
        : across(z, CHEST_Z - 0.06, 0.08, BONE_SPINE, BONE_CHEST),
  );
  // Tail: out of the rump, tapering, its tip rounded and white.
  const tailBack = TAIL_ROOT_Z - TAIL_STEP * TAIL_SEGMENTS;
  const tail = stations(
    tailBack,
    TAIL_ROOT_Z + 0.07,
    30,
    () => BODY_Y + TAIL_ROOT_Y,
    (u) => {
      const r = 0.036 + 0.018 * u;
      return [r, r];
    },
  );
  addTube(
    tube,
    tail,
    (z) => (z < tailBack + 0.07 ? 0 : 1),
    (z) => {
      if (z > TAIL_ROOT_Z) return [BONE_HIPS, 1, BONE_TAIL, 0];
      // Each segment rides its bone, blended across the joints.
      const t = (TAIL_ROOT_Z - z) / TAIL_STEP;
      const i = Math.min(TAIL_SEGMENTS - 1, Math.floor(t));
      const f = t - i;
      const bone = BONE_TAIL + i;
      if (f < 0.5) {
        const before = i === 0 ? BONE_HIPS : bone - 1;
        return [bone, 0.5 + f, before, 0.5 - f];
      }
      if (i === TAIL_SEGMENTS - 1) return [bone, 1, bone, 0];
      return [bone, 1.5 - f, bone + 1, f - 0.5];
    },
  );
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(tube.positions, 3),
  );
  g.setAttribute("normal", new THREE.Float32BufferAttribute(tube.normals, 3));
  g.setAttribute("coat", new THREE.Float32BufferAttribute(tube.patch, 1));
  g.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute(tube.skinIndex, 4),
  );
  // Weights normalised (a joint's two can come out a hair over 1).
  const sw = tube.skinWeight;
  for (let i = 0; i < sw.length; i += 4) {
    const sum = sw[i] + sw[i + 1] + sw[i + 2] + sw[i + 3] || 1;
    for (let j = 0; j < 4; j++) sw[i + j] /= sum;
  }
  g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(tube.index);
  g.computeBoundingSphere();
  bodyGeometry = g;
  return g;
}

/** An ellipsoid with a patch coat painted by `coat` (position → 0..1). */
function ellipsoid(
  rx: number,
  ry: number,
  rz: number,
  coat?: (x: number, y: number, z: number) => number,
  segments = 20,
): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, segments, Math.round(segments * 0.7));
  g.scale(rx, ry, rz);
  // Scaling squashed the normals' directions too: re-derive them from the
  // ellipsoid's own surface.
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  const patch = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = new THREE.Vector3(x / (rx * rx), y / (ry * ry), z / (rz * rz));
    n.normalize();
    nor.setXYZ(i, n.x, n.y, n.z);
    patch[i] = coat ? coat(x / rx, y / ry, z / rz) : 0;
  }
  g.setAttribute("coat", new THREE.BufferAttribute(patch, 1));
  return g;
}

type Parts = {
  head: THREE.BufferGeometry;
  neck: THREE.BufferGeometry;
  cheeks: THREE.BufferGeometry;
  muzzle: THREE.BufferGeometry;
  nose: THREE.BufferGeometry;
  eye: THREE.BufferGeometry;
  shine: THREE.BufferGeometry;
  ear: THREE.BufferGeometry;
  innerEar: THREE.BufferGeometry;
  paw: THREE.BufferGeometry;
  legs: THREE.BufferGeometry[][];
};
let parts: Parts | null = null;

function catParts(): Parts {
  if (parts) return parts;
  const ear = new THREE.ConeGeometry(0.062, 0.12, 14, 1);
  ear.translate(0, 0.06, 0);
  ear.scale(1, 1, 0.55);
  const innerEar = new THREE.ConeGeometry(0.04, 0.085, 12, 1);
  innerEar.translate(0, 0.045, 0);
  innerEar.scale(1, 1, 0.3);
  parts = {
    // A round head, wider than tall: an orange cap with a white blaze down
    // the brow.
    head: ellipsoid(0.165, 0.145, 0.15, (x, y, z) => {
      const blaze = Math.abs(x) < 0.16 + 0.35 * (0.6 - y) && z > 0.2;
      return y > -0.05 + 0.15 * Math.abs(x) && !blaze ? 1 : 0;
    }),
    cheeks: ellipsoid(0.135, 0.085, 0.11),
    // The ruff under its chin, joining head to chest: white, the back of it
    // orange.
    neck: ellipsoid(0.115, 0.15, 0.12, (_x, y, z) =>
      y > 0.1 && z < 0.2 ? 1 : 0,
    ),
    muzzle: ellipsoid(0.04, 0.032, 0.036, undefined, 12),
    nose: ellipsoid(0.022, 0.014, 0.014, undefined, 10),
    eye: ellipsoid(0.03, 0.036, 0.016, undefined, 14),
    shine: ellipsoid(0.009, 0.009, 0.006, undefined, 8),
    ear,
    innerEar,
    paw: ellipsoid(0.05, PAW_Y, 0.062, undefined, 14),
    legs: LEGS.map((l) => [
      new THREE.CapsuleGeometry(l.upperRadius, l.upper, 6, 12),
      new THREE.CapsuleGeometry(l.lowerRadius, l.lower, 6, 12),
    ]),
  };
  return parts;
}

// --- The model --------------------------------------------------------------

type Leg = {
  spec: LegSpec;
  bone: THREE.Bone;
  upper: THREE.Mesh;
  lower: THREE.Mesh;
  paw: THREE.Mesh;
};

/** Shading for `hex`: the herzies' wearable bands of it. */
const NO_COLORS: ColorTriplet = { dim: "#000", base: "#000", bright: "#000" };
function shading(hex: string) {
  return primitiveShading({ zone: "wearable", color: hex }, NO_COLORS);
}

export class CatModel {
  /** In the world at its feet, turned to its heading. */
  readonly group = new THREE.Group();
  /** Tilted to the ground under it and leaning into turns. */
  private readonly tilt = new THREE.Group();
  /** Lifted off the ground (a pounce). */
  private readonly lift = new THREE.Group();
  private readonly body: THREE.SkinnedMesh;
  private readonly hips: THREE.Bone;
  private readonly spine: THREE.Bone;
  private readonly chest: THREE.Bone;
  private readonly tail: THREE.Bone[] = [];
  private readonly neck = new THREE.Group();
  private readonly headTurn = new THREE.Group();
  private readonly ears: THREE.Group[] = [];
  private readonly eyes: THREE.Mesh[] = [];
  private readonly legs: Leg[] = [];
  /** The point an item it carries sits at (in its head's space). */
  private readonly mouth = new THREE.Object3D();
  readonly materials: THREE.Material[] = [];

  constructor(scheme: SchemeUniforms, lighting?: HerzieLighting) {
    const p = catParts();
    const coat = herzieMaterial(
      shading(WHITE),
      0,
      null,
      scheme,
      lighting,
      1,
      undefined,
      shading(ORANGE).shades,
    );
    const white = herzieMaterial(shading(WHITE), 0, null, scheme, lighting);
    const orange = herzieMaterial(shading(ORANGE), 0, null, scheme, lighting);
    const pink = herzieMaterial(shading(PINK), 0, null, scheme, lighting);
    const eye = herzieMaterial(
      primitiveShading({ zone: "pupil" }, NO_COLORS),
      0,
      null,
      scheme,
      lighting,
    );
    eye.uniforms.uShades.value = [EYE, EYE, EYE].map((h) => new THREE.Color(h));
    const shine = new THREE.MeshBasicMaterial({ color: "#ffffff" });
    this.materials.push(coat, white, orange, pink, eye, shine);
    const mesh = (
      g: THREE.BufferGeometry,
      m: THREE.Material,
      shadow = true,
    ): THREE.Mesh => {
      const out = new THREE.Mesh(g, m);
      out.castShadow = shadow;
      out.receiveShadow = true;
      return out;
    };

    // The skeleton: hips → spine → chest, the tail off the hips.
    this.hips = new THREE.Bone();
    this.hips.position.set(0, BODY_Y, HIPS_Z);
    this.spine = new THREE.Bone();
    this.spine.position.set(0, 0, SPINE_Z - HIPS_Z);
    this.chest = new THREE.Bone();
    this.chest.position.set(0, 0, CHEST_Z - SPINE_Z);
    this.hips.add(this.spine);
    this.spine.add(this.chest);
    let parent = this.hips;
    for (let i = 0; i < TAIL_SEGMENTS; i++) {
      const b = new THREE.Bone();
      if (i === 0) b.position.set(0, TAIL_ROOT_Y, TAIL_ROOT_Z - HIPS_Z);
      else b.position.set(0, 0, -TAIL_STEP);
      parent.add(b);
      this.tail.push(b);
      parent = b;
    }
    this.body = new THREE.SkinnedMesh(catBodyGeometry(), coat);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    // It bends out of any box worked out at rest.
    this.body.frustumCulled = false;
    this.body.add(this.hips);
    this.body.updateMatrixWorld(true);
    this.body.bind(
      new THREE.Skeleton([this.hips, this.spine, this.chest, ...this.tail]),
    );

    // The head, on its neck off the chest.
    this.neck.position.set(...NECK);
    this.chest.add(this.neck);
    // The ruff: on the chest, under where the head turns, tipped forward.
    const ruff = mesh(p.neck, coat);
    ruff.position.set(0, 0.05, 0.1);
    ruff.rotation.x = 0.5;
    this.chest.add(ruff);
    this.neck.add(this.headTurn);
    const head = new THREE.Group();
    head.position.set(0, 0.09, 0.07);
    this.headTurn.add(head);
    head.add(mesh(p.head, coat));
    const cheeks = mesh(p.cheeks, white);
    cheeks.position.set(0, -0.05, 0.05);
    head.add(cheeks);
    for (const side of [-1, 1]) {
      const m = mesh(p.muzzle, white);
      m.position.set(side * 0.03, -0.062, 0.135);
      head.add(m);
    }
    const nose = mesh(p.nose, pink, false);
    nose.position.set(0, -0.03, 0.158);
    head.add(nose);
    for (const side of [-1, 1]) {
      const e = mesh(p.eye, eye, false);
      e.position.set(side * 0.066, 0.012, 0.128);
      e.rotation.y = side * 0.45;
      head.add(e);
      this.eyes.push(e);
      const s = mesh(p.shine, shine, false);
      s.position.set(0.008, 0.014, 0.012);
      e.add(s);
      // Ears: on the crown, tipped out a little.
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.085, 0.095, -0.015);
      pivot.rotation.set(-0.12, 0, -side * 0.32);
      const ear = mesh(p.ear, orange);
      pivot.add(ear);
      const inner = mesh(p.innerEar, pink, false);
      inner.position.set(0, 0.006, 0.02);
      pivot.add(inner);
      head.add(pivot);
      this.ears.push(pivot);
    }
    this.mouth.position.set(0, -0.085, 0.17);
    head.add(this.mouth);

    // Legs: placed each frame between where they hang and where the feet
    // go, so they live in the tilted frame, not on the bones.
    LEGS.forEach((spec, i) => {
      const [upperG, lowerG] = p.legs[i];
      const leg: Leg = {
        spec,
        bone: spec.bone === "chest" ? this.chest : this.hips,
        upper: mesh(upperG, white),
        lower: mesh(lowerG, white),
        paw: mesh(p.paw, white),
      };
      this.lift.add(leg.upper, leg.lower, leg.paw);
      this.legs.push(leg);
    });

    this.lift.add(this.body);
    this.tilt.add(this.lift);
    this.group.add(this.tilt);
  }

  /** Where an item it carries goes (world space). */
  mouthPosition(out: THREE.Vector3): THREE.Vector3 {
    this.group.updateWorldMatrix(true, true);
    return this.mouth.getWorldPosition(out);
  }

  /** Shows it posed as `state` says, at `scale`. */
  pose(state: CatState, scale: number): void {
    poseCat(this, state, scale);
  }

  /** Its materials that aren't the herzies' own shading (a host disposes
   * those with the herzie's). */
  dispose(): void {
    for (const m of this.materials)
      if (!(m instanceof THREE.ShaderMaterial)) m.dispose();
  }

  /** @internal Parts for posing (see poseCat). */
  get bones() {
    return {
      tilt: this.tilt,
      lift: this.lift,
      hips: this.hips,
      spine: this.spine,
      chest: this.chest,
      tail: this.tail,
      neck: this.neck,
      headTurn: this.headTurn,
      ears: this.ears,
      eyes: this.eyes,
      legs: this.legs,
    };
  }
}

// --- Posing -----------------------------------------------------------------

const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const UP = new THREE.Vector3(0, 1, 0);
const hip = new THREE.Vector3();
const foot = new THREE.Vector3();
const knee = new THREE.Vector3();
const dir = new THREE.Vector3();
const pole = new THREE.Vector3();
const scratch = new THREE.Vector3();
const toLocal = new THREE.Matrix4();

/** Puts a capsule between two points (its geometry runs along y). */
function between(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
  m.position.addVectors(a, b).multiplyScalar(0.5);
  dir.subVectors(b, a);
  const l = dir.length();
  if (l > 1e-6) m.quaternion.setFromUnitVectors(UP, dir.multiplyScalar(1 / l));
}

/**
 * Two-bone reach from `h` to `f` with lengths `a` and `b`, the knee bent
 * toward `toward`: writes the knee into `knee`, and pulls `f` in if it's out
 * of reach.
 */
function reach(
  h: THREE.Vector3,
  f: THREE.Vector3,
  a: number,
  b: number,
  toward: THREE.Vector3,
) {
  dir.subVectors(f, h);
  let d = dir.length();
  if (d < 1e-6) {
    dir.set(0, -1, 0);
    d = 1e-6;
  } else dir.multiplyScalar(1 / d);
  const most = (a + b) * 0.999;
  const least = Math.abs(a - b) + 1e-3;
  if (d > most) {
    d = most;
    f.copy(h).addScaledVector(dir, d);
  } else if (d < least) {
    d = least;
    f.copy(h).addScaledVector(dir, d);
  }
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const along = a * cosA;
  const out = a * Math.sqrt(1 - cosA * cosA);
  pole.copy(toward).addScaledVector(dir, -toward.dot(dir));
  if (pole.lengthSq() < 1e-8) pole.set(0, 0, 1);
  pole.normalize();
  knee.copy(h).addScaledVector(dir, along).addScaledVector(pole, out);
}

/** Writes `state` onto `model`'s bones and parts, at the herzie's size
 * `scale`. Allocation-free. */
export function poseCat(model: CatModel, state: CatState, scale: number) {
  const b = model.bones;
  const t = state.clock;
  const sit = clamp(state.rest, 0, 1);
  const lie = clamp(state.rest - 1, 0, 1);
  const sleep = clamp(state.rest - 2, 0, 1);
  const stretch = envelope(state.stretch, T.STRETCH_SECONDS);
  const yawn = envelope(state.yawn, T.YAWN_SECONDS);
  const groom = envelope(state.groom, T.GROOM_SECONDS);
  const pounce = catPounce(state);
  const crouch = pounceCrouch(pounce);
  const moving = state.moving;
  const trot = state.trot;
  const cycle = state.phase * Math.PI * 2;
  const k = scale;

  // Where it stands, which way, tilted to the ground and into turns.
  model.group.position.copy(state.position);
  model.group.rotation.set(0, state.heading, 0);
  model.group.scale.setScalar(k);
  b.tilt.rotation.set(
    -state.slopePitch,
    0,
    state.slopeRoll + state.lean,
    "YXZ",
  );
  b.lift.position.y = pounce >= 0 ? pounceLift(pounce) : 0;

  // The body: lowered and pitched by how it rests. Sitting rocks it back
  // onto its haunches (nose up); lying sets it down level; a stretch bows
  // the front down; a crouch flattens it, rump wiggling.
  const breath =
    Math.sin(t * Math.PI * 2 * lerp(0.75, 0.32, sleep)) *
    lerp(0.012, 0.02, sleep);
  const bob =
    moving *
    (Math.sin(cycle * 2) * lerp(0.008, 0.018, trot) +
      Math.abs(Math.sin(cycle * 2)) * trot * 0.008);
  const hipsY =
    lerp(lerp(lerp(BODY_Y, 0.17, sit), 0.15, lie), 0.13, sleep) -
    crouch * 0.12 +
    stretch * 0.03 +
    bob;
  const pitch =
    sit * (1 - lie) * 0.78 -
    stretch * 0.42 -
    crouch * 0.06 +
    moving * Math.sin(cycle * 2 + 0.6) * 0.02;
  b.hips.position.set(
    Math.sin(t * 13) * crouch * 0.012 * (pounce < 0.45 ? 1 : 0),
    hipsY,
    HIPS_Z - sit * (1 - lie) * 0.02,
  );
  b.hips.rotation.set(-pitch, 0, 0, "YXZ");
  // The spine: into its turns (the body's one curve, nose to tail), a sway
  // in the stretch, curled round asleep.
  const curl = lerp(0.12 * lie, 0.5, sleep) * state.side;
  const bend = clamp(state.turnRate * 0.06, -0.25, 0.25) * moving;
  b.spine.rotation.set(stretch * 0.18 - sit * 0.05, curl + bend, 0, "YXZ");
  b.chest.rotation.set(-stretch * 0.1, curl * 0.8 + bend, 0, "YXZ");
  b.chest.scale.setScalar(1 + breath);

  // Head: kept level-ish whatever the body does, turned to what it looks
  // at, down on its paws asleep, down to a paw grooming, up for a yawn.
  const counter = pitch - stretch * 0.2;
  const curlBack = -(curl * 1.6);
  const headYaw =
    lerp(state.headYaw, curlBack + 0.2 * Math.sign(curlBack), sleep) -
    (curl * 0.8 + bend) * (1 - sleep) +
    groom * 0.25;
  const headPitch =
    lerp(state.headPitch, -0.35, sleep) -
    counter * 0.85 * (1 - sleep) -
    groom * (0.75 + Math.sin(t * Math.PI * 2 * 3.2) * 0.1) +
    yawn * 0.45 +
    lie * (1 - sleep) * 0.05 -
    moving * Math.sin(cycle * 2) * 0.03;
  b.neck.position.set(
    NECK[0],
    NECK[1] - sleep * 0.1 - groom * 0.03,
    NECK[2] + sleep * 0.04,
  );
  b.headTurn.rotation.set(-headPitch, headYaw, groom * 0.15, "YXZ");
  b.headTurn.scale.set(1, 1 + yawn * 0.04, 1);

  // Ears: they lead the head; one twitches now and then; relaxed asleep.
  const lead = (state.earYaw - state.headYaw) * 0.9;
  const twitch = envelope(state.twitch, T.TWITCH_SECONDS);
  b.ears.forEach((ear, i) => {
    const side = i === 0 ? -1 : 1;
    const flick = state.twitchEar === side ? twitch * 0.5 : 0;
    ear.rotation.set(
      -0.12 - flick * 0.4 + sleep * 0.2 - groom * 0.1,
      lead + side * (sleep * 0.25 + flick * 0.3),
      -side * (0.32 + sleep * 0.25 + yawn * 0.15),
      "YXZ",
    );
  });

  // Eyes: blinks, shut asleep and yawning, heavy-lidded lying about.
  const blink = state.blink >= 0 ? envelope(state.blink, T.BLINK_SECONDS) : 0;
  const shut = clamp(
    Math.max(blink, sleep, yawn * 0.95, groom * 0.7, lie * 0.45),
    0,
    0.94,
  );
  for (const e of b.eyes) e.scale.set(1, 1 - shut, 1);

  // Tail.
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    b.tail[i].rotation.set(state.tailPitch[i], state.tailYaw[i], 0, "YXZ");
  }

  // Legs: where each hangs from (on its bone, now), and where its paw goes.
  model.group.updateMatrixWorld(true);
  toLocal.copy(b.lift.matrixWorld).invert();
  const duty = lerp(0.62, 0.5, trot);
  const stride = lerp(0.62, 1.1, trot) / CAT_LENGTH;
  const step = stride * duty * CAT_LENGTH;
  const lifted = lerp(0.07, 0.11, trot);
  for (let i = 0; i < b.legs.length; i++) {
    const leg = b.legs[i];
    const { spec } = leg;
    hip
      .set(...spec.at)
      .applyMatrix4(leg.bone.matrixWorld)
      .applyMatrix4(toLocal);
    const fore = spec.bone === "chest";
    // Standing: under where it hangs.
    const side = Math.sign(spec.at[0]);
    foot.set(hip.x * 0.95, PAW_Y, hip.z + (fore ? 0.01 : -0.02));
    // Walking: stance sweeps back at the ground's pace, swing lifts forward.
    if (moving > 1e-3) {
      const offset = lerp(spec.walk, spec.trot, trot);
      const p = (state.phase + offset) % 1;
      let dz: number;
      let dy = 0;
      if (p < duty) dz = step * (0.5 - p / duty);
      else {
        const u = (p - duty) / (1 - duty);
        dz = step * (-0.5 + u * u * (3 - 2 * u));
        dy = lifted * Math.sin(u * Math.PI);
      }
      foot.z += dz * moving;
      foot.y += dy * moving;
    }
    // Sitting: forepaws planted under the chest; hind paws forward beside
    // the haunches, folded.
    if (sit > 0) {
      const fx = fore ? hip.x * 0.9 : side * 0.11;
      const fz = fore ? hip.z + 0.02 : hip.z + 0.16;
      foot.x = lerp(foot.x, fx, sit);
      foot.y = lerp(foot.y, PAW_Y, sit);
      foot.z = lerp(foot.z, fz, sit);
    }
    // Lying: forepaws out in front, hind tucked under.
    if (lie > 0) {
      const fz = fore ? hip.z + 0.2 - sleep * 0.08 : hip.z + 0.12;
      const fx = fore
        ? side * (0.06 - sleep * 0.02)
        : side * (0.13 + sleep * 0.02);
      foot.x = lerp(foot.x, fx, lie);
      foot.y = lerp(foot.y, PAW_Y, lie);
      foot.z = lerp(foot.z, fz, lie);
    }
    // Stretching: forepaws reach far out.
    if (stretch > 0 && fore) foot.z += stretch * 0.22;
    // Grooming: the right forepaw up to its mouth.
    if (groom > 0 && fore && side < 0) {
      b.headTurn.getWorldPosition(scratch).applyMatrix4(toLocal);
      foot.x = lerp(foot.x, -0.02, groom);
      foot.y = lerp(foot.y, scratch.y + 0.04, groom);
      foot.z = lerp(foot.z, scratch.z + 0.1, groom);
    }
    // Knees: hind legs forward, forelegs back (and out a little).
    scratch.set(side * 0.15, 0, spec.knee);
    reach(hip, foot, spec.upper, spec.lower, scratch);
    between(leg.upper, hip, knee);
    between(leg.lower, knee, foot);
    leg.paw.position.copy(foot);
    leg.paw.position.y = Math.max(foot.y, PAW_Y * 0.9);
  }
}
