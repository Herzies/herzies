import * as THREE from "three";

/**
 * Eivind's Wings: a pair of feathered wings on the herzie's back, built as a
 * skeleton (shoulder, elbow, wrist) with rows of feathers hung off it, and
 * moved like wings rather than like cloth:
 *
 *  - Resting, they fold: the wrist rides up over the shoulder and the
 *    feathers hang down the back in overlapping rows, breathing a little.
 *  - Now and then they stretch: a slow unfurl and one lazy beat.
 *  - Walking or running they open a touch and sweep back with the speed.
 *  - Airborne they spread wide: beating while it rises, gliding as it falls.
 *  - Every beat travels down the wing: the elbow, then the wrist, then each
 *    feather lags the one before it, and feathers bend back against a fast
 *    stroke, so a flap ripples out to the tips.
 *
 * Built in creature space (y down, the front facing −z, the back +z) on the
 * torso, and drawn as one mesh a wing, its feathers rewritten each frame.
 */

type V3 = [number, number, number];

/** The item that wears them (items.ts). */
export const WINGS_ITEM_ID = "eivinds-wings";

/** Feathers of each kind, per wing. */
const PRIMARIES = 8;
const SECONDARIES = 9;
const COVERTS = 9;
/** Rows of vertices down a feather. */
const ROWS = 6;

/** Wing size, as a share of the torso's radius. */
const SIZE = 0.95;

/** How quickly the wings open and close (per second). */
const OPEN_RATE = 8;
const CLOSE_RATE = 5;
/** How quickly each joint follows the one before it (per second): the
 * lower, the longer the ripple. */
const FOLLOW_ELBOW = 26;
const FOLLOW_WRIST = 18;
const FOLLOW_TIP = 12;
/** Beats a second, rising; and for the lazy beat of a stretch. */
const BEAT_RATE = 2.6;
const STRETCH_BEAT_RATE = 0.9;
/** How long a stretch lasts (s), and how long between them (s, plus a
 * little each time). */
const STRETCH_TIME = 1.7;
const STRETCH_EVERY = 9;
/** Creature units a second at which a walker counts as running flat out. */
const RUN_SPEED = 3.2;

export interface WingsInput {
  /** How far the pose has moved the torso from rest. */
  offset: V3;
  /** Its velocity in creature space (y down). */
  velocity: V3;
  /** How high it is above the ground, in creature units. */
  jump: number;
  /** 0 standing to 1 sat. */
  sit: number;
}

interface Feather {
  /** 0 primary, 1 secondary, 2 covert. */
  kind: number;
  /** 0 to 1 along its row, from the outer end. */
  rank: number;
  /** Where along the arm it's rooted (see rootAt). */
  at: number;
  length: number;
  width: number;
  /** How far over the flight feathers it lies, as an offset from the
   * surface (coverts lie over the row they cover). */
  lift: number;
  /** Its direction folded and open, unit. */
  folded: V3;
  open: V3;
  /** A phase for its own flutter. */
  phase: number;
}

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const lerp3 = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const smooth = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};
/** Turns `v` about the front-back axis (z) by `a` radians: a wing's beat.
 * Positive lowers an outstretched wing (y is down). */
const rotZ = (v: V3, a: number): V3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
};

/** A feather's outline: width at `t` along it, 0 to 1 — round shouldered,
 * coming to a point. */
function outline(t: number): number {
  return Math.sin(Math.PI * (0.12 + 0.88 * t) ** 0.8);
}

/** The feathers of a wing, as laid out folded and open. A right wing: x
 * runs outward, y down, z backward. */
function layOut(a: number): Feather[] {
  const out: Feather[] = [];
  const deg = Math.PI / 180;
  // Primaries: the long outer feathers fanned off the wrist.
  for (let i = 0; i < PRIMARIES; i++) {
    const r = i / (PRIMARIES - 1);
    const beta = (8 + 56 * r) * deg;
    out.push({
      kind: 0,
      rank: r,
      at: 0.28 * r,
      length: a * (1.2 - 0.2 * r),
      width: a * 0.3,
      lift: 0,
      open: norm([Math.cos(beta), -0.03, Math.sin(beta)]),
      folded: norm([0.4 - 0.75 * r, 1, 0.16 + 0.1 * r]),
      phase: i * 1.7,
    });
  }
  // Secondaries: along the forearm and on down the upper arm, pointing back.
  for (let i = 0; i < SECONDARIES; i++) {
    const r = i / (SECONDARIES - 1);
    const beta = (68 + 26 * r) * deg;
    out.push({
      kind: 1,
      rank: r,
      at: 0.34 + 0.66 * r,
      length: a * (1.05 - 0.25 * r),
      width: a * 0.34,
      lift: 0.012 * a,
      open: norm([Math.cos(beta) * 0.6, 0.02, Math.sin(beta)]),
      folded: norm([0.05 - 0.45 * r, 1, 0.1 + 0.08 * r]),
      phase: i * 2.1 + 5,
    });
  }
  // Coverts: short feathers lying over the roots of the long ones.
  for (let i = 0; i < COVERTS; i++) {
    const r = i / (COVERTS - 1);
    const beta = (52 + 34 * r) * deg;
    out.push({
      kind: 2,
      rank: r,
      at: 0.1 + 0.88 * r,
      length: a * (0.62 - 0.14 * r),
      width: a * 0.27,
      lift: 0.03 * a,
      open: norm([Math.cos(beta) * 0.75, 0.0, Math.sin(beta)]),
      folded: norm([0.3 - 0.6 * r, 1, 0.14 + 0.06 * r]),
      phase: i * 1.3 + 9,
    });
  }
  return out;
}

export class Wings {
  /** Add this to the creature. */
  readonly group = new THREE.Group();
  /** A sphere round everything a wing reaches, in creature space. */
  readonly reach: { center: V3; radius: number };

  private readonly a: number;
  private readonly root: V3;
  private readonly feathers: Feather[];
  private readonly dx: number;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly positions: Float32Array[] = [];
  private readonly normals: Float32Array[] = [];

  private time = 0;
  /** 0 folded to 1 spread wide. */
  private spread = 0;
  /** The beat: the shoulder's angle, then the elbow's and wrist's, which
   * follow it, and how fast it's turning (feathers bend against that). */
  private beat = 0;
  private elbow = 0;
  private wrist = 0;
  private tip = 0;
  private beatRate = 0;
  private beatPhase = 0;
  private beatAmp = 0;
  /** A stretch's progress, 0 when not stretching. */
  private stretching = 0;
  private nextStretch: number;
  private lastJump = 0;
  private rise = 0;
  /** How far it sweeps back with its speed. */
  private sweep = 0;
  private lean = 0;
  /** Nothing but its breathing is going on. */
  private quiet = false;

  constructor(
    body: { center: V3; radius: number },
    material: THREE.Material,
    seed = 0,
  ) {
    this.a = body.radius * SIZE;
    const a = this.a;
    this.feathers = layOut(a);
    this.dx = 0.3 * body.radius;
    // On the back, between the shoulder blades and a little above the
    // middle, sat on the torso's skin.
    const dx = 0.3 * body.radius;
    const dy = -0.32 * body.radius;
    const dz = Math.sqrt(Math.max(0, 1 - 0.3 ** 2 - 0.32 ** 2)) * body.radius;
    this.root = [
      body.center[0] + dx,
      body.center[1] + dy,
      body.center[2] + dz + 0.05,
    ];
    this.reach = {
      center: [body.center[0], body.center[1] - a * 0.2, body.center[2] + dz],
      radius: a * 3.4 + dx,
    };
    this.nextStretch = STRETCH_EVERY * (0.5 + ((seed % 7) / 7) * 0.8);
    for (const side of [1, -1]) {
      const geometry = this.buildGeometry(side);
      this.geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    this.rewrite();
  }

  private buildGeometry(side: number): THREE.BufferGeometry {
    const count = this.feathers.length;
    const perFeather = ROWS * 2;
    const positions = new Float32Array(count * perFeather * 3);
    const normals = new Float32Array(count * perFeather * 3);
    const uvs = new Float32Array(count * perFeather * 2);
    const index: number[] = [];
    for (let f = 0; f < count; f++) {
      const base = f * perFeather;
      for (let r = 0; r < ROWS; r++) {
        const t = r / (ROWS - 1);
        for (let s = 0; s < 2; s++) {
          const v = base + r * 2 + s;
          uvs[v * 2] = s;
          uvs[v * 2 + 1] = t;
        }
        if (r < ROWS - 1) {
          const a = base + r * 2;
          const b = a + 1;
          const c = a + 2;
          const d = a + 3;
          // Wound so the front is the feather's normal's side; a mirrored
          // wing is wound the other way.
          if (side > 0) index.push(a, b, c, b, d, c);
          else index.push(a, c, b, b, c, d);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(positions, 3);
    position.setUsage(THREE.DynamicDrawUsage);
    const normal = new THREE.BufferAttribute(normals, 3);
    normal.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", position);
    geometry.setAttribute("normal", normal);
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(index);
    this.positions.push(positions);
    this.normals.push(normals);
    return geometry;
  }

  /** Whether the wings are at rest: nothing for a still view to redraw. */
  get settled(): boolean {
    return this.quiet;
  }

  /** Moves the wings on by `dt` seconds. */
  update(dt: number, input: WingsInput) {
    this.group.position.set(...input.offset);
    if (!(dt > 0)) return;
    this.time += dt;
    const v = input.velocity;
    const speed = Math.hypot(v[0], v[2]);
    const run = Math.min(1, speed / RUN_SPEED);
    // Rising or falling, from how its height changes (the velocity's
    // vertical part is smoothed too long to catch a hop).
    const climb = (input.jump - this.lastJump) / dt;
    this.lastJump = input.jump;
    this.rise += (climb - this.rise) * (1 - Math.exp(-dt * 14));
    const airborne = input.jump > 0.04;
    const rising = airborne && this.rise > 0.15;

    // A stretch, now and then, when standing about.
    const idle = !airborne && run < 0.05 && input.sit < 0.2;
    if (idle) {
      this.nextStretch -= dt;
      if (this.nextStretch <= 0 && this.stretching === 0) {
        this.stretching = 1e-4;
      }
    } else if (this.stretching > 0) {
      this.stretching = 0;
      this.nextStretch = STRETCH_EVERY * 0.6;
    }
    if (this.stretching > 0) {
      this.stretching += dt / STRETCH_TIME;
      if (this.stretching >= 1) {
        this.stretching = 0;
        this.nextStretch = STRETCH_EVERY * (0.8 + 0.5 * Math.sin(this.time));
      }
    }
    const stretch =
      this.stretching > 0 ? Math.sin(Math.PI * this.stretching) ** 0.8 : 0;

    // What it's aiming for.
    let target = 0.04 + 0.05 * Math.sin(this.time * 1.6) ** 2; // breathing
    let rate = BEAT_RATE;
    let amp = 0;
    if (airborne) {
      target = rising ? 1 : 0.86;
      amp = rising ? 0.5 : 0.08 + 0.05 * Math.sin(this.time * 3);
      rate = rising ? BEAT_RATE * 1.15 : 1.4;
    } else if (input.sit > 0.2) {
      target = 0.0;
    } else {
      target = Math.max(target, 0.1 + 0.2 * run);
      amp = 0.12 * run;
      rate = 1.4 + 2.2 * run;
      if (stretch > 0) {
        target = Math.max(target, 0.2 + 0.5 * stretch);
        amp = Math.max(amp, 0.32 * stretch);
        rate = STRETCH_BEAT_RATE;
      }
    }
    target *= 1 - 0.8 * input.sit;
    const k = target > this.spread ? OPEN_RATE : CLOSE_RATE;
    this.spread += (target - this.spread) * (1 - Math.exp(-dt * k));
    if (Math.abs(this.spread - target) < 0.002 && target < 0.1) {
      this.spread = target > 0.01 ? this.spread : 0;
    }

    // The beat.
    this.beatAmp += (amp - this.beatAmp) * (1 - Math.exp(-dt * 7));
    this.beatPhase += dt * rate * Math.PI * 2;
    // Wings are raised at the top of the stroke and swept down hard: a
    // little more time up than down.
    const wave = Math.sin(this.beatPhase);
    const stroke = wave + 0.22 * Math.sin(this.beatPhase * 2 + 0.6);
    const shoulder = this.beatAmp * stroke;
    this.beat = shoulder;
    this.elbow += (this.beat - this.elbow) * (1 - Math.exp(-dt * FOLLOW_ELBOW));
    const wristBefore = this.wrist;
    this.wrist +=
      (this.elbow - this.wrist) * (1 - Math.exp(-dt * FOLLOW_WRIST));
    this.tip += (this.wrist - this.tip) * (1 - Math.exp(-dt * FOLLOW_TIP));
    this.beatRate = (this.wrist - wristBefore) / dt;

    // Swept back with speed, and leaning into a turn of pace.
    this.sweep += (run - this.sweep) * (1 - Math.exp(-dt * 6));
    this.lean += (Math.sign(v[2]) * run - this.lean) * (1 - Math.exp(-dt * 4));
    this.quiet =
      idle &&
      this.stretching === 0 &&
      this.beatAmp < 0.004 &&
      Math.abs(this.wrist) < 0.004 &&
      this.sweep < 0.004;
    this.rewrite();
  }

  /** Where along the arm (0 at the wrist to 1 at the shoulder) a point is,
   * for the arm bent at `elbow`. */
  private static along(wrist: V3, elbow: V3, shoulder: V3, t: number): V3 {
    // The forearm takes the first 0.6 of the way, the upper arm the rest.
    if (t < 0.6) return lerp3(wrist, elbow, t / 0.6);
    return lerp3(elbow, shoulder, (t - 0.6) / 0.4);
  }

  /** Rewrites both wings' feathers for the pose. */
  private rewrite() {
    const a = this.a;
    const s = smooth(this.spread);
    // The arm: folded, the wrist rides up over the shoulder and the forearm
    // comes back down; open, it's out and swept back.
    const sweep = this.sweep;
    const dir1: V3 = norm(
      lerp3([0.28, -1.0, 0.34], [1.0, -0.42, 0.28 + 0.25 * sweep], s),
    );
    const dir2: V3 = norm(
      lerp3([0.16, 1.0, 0.42], [1.0, -0.04, 0.5 + 0.45 * sweep], s),
    );
    // Beating swings each joint about the shoulder's front-back axis, the
    // further joints lagging. Opened wide it's the whole arm; folded, a
    // small shrug.
    const swing = 0.35 + 0.65 * s;
    const d1 = rotZ(dir1, -this.beat * swing);
    const d2 = rotZ(dir2, -(this.elbow * 1.1 + this.wrist * 0.4) * swing);
    const L1 = a * 0.95;
    const L2 = a * 1.0;
    const shoulder: V3 = [0, 0, 0];
    const elbow: V3 = [d1[0] * L1, d1[1] * L1, d1[2] * L1];
    const wrist: V3 = [
      elbow[0] + d2[0] * L2,
      elbow[1] + d2[1] * L2,
      elbow[2] + d2[2] * L2,
    ];
    // The broad faces of the feathers: folded, they lie flat to the back,
    // facing away from it; open, they face up (and forward a touch).
    const nFold: V3 = [0.3, 0, 1];
    const nOpen: V3 = [0, -1, 0.15];
    const time = this.time;
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1;
      const pos = this.positions[side];
      const nor = this.normals[side];
      let o = 0;
      this.feathers.forEach((f) => {
        // Where it's rooted.
        const t = f.kind === 0 ? 0.0 : f.at;
        const rootAt =
          f.kind === 0
            ? lerp3(wrist, elbow, f.at)
            : Wings.along(wrist, elbow, shoulder, t);
        // Its direction: folded to open, bent back by the beat's speed, then
        // lagging the wrist by how far out along the wing it is.
        let d = lerp3(f.folded, f.open, s);
        const flutter =
          0.03 * Math.sin(time * 2.4 + f.phase) * (1 - 0.6 * s) +
          0.06 * this.beatAmp * Math.sin(time * 9 + f.phase);
        d = [d[0], d[1] + flutter, d[2] + 0.6 * this.sweep * (1 - s * 0.4)];
        // The tip of each feather lags the wrist, the longer the further.
        const lag = this.tip - this.wrist;
        const own =
          -(this.wrist + lag * (0.5 + 0.5 * f.rank)) * swing -
          this.beatRate * 0.018 * (f.kind === 0 ? 1.4 : 0.8);
        d = rotZ(norm(d), own);
        d = norm(d);
        let n: V3 = norm(lerp3(nFold, nOpen, s));
        const nd = dot(n, d);
        n = norm([n[0] - d[0] * nd, n[1] - d[1] * nd, n[2] - d[2] * nd]);
        const w = cross(n, d); // across the feather
        const root: V3 = [
          rootAt[0] + n[0] * f.lift * (f.kind === 2 ? 1 : 0),
          rootAt[1] + n[1] * f.lift * (f.kind === 2 ? 1 : 0),
          rootAt[2] + n[2] * f.lift * (f.kind === 2 ? 1 : 0) + 0,
        ];
        // Flight feathers stack behind one another: nudge each row along
        // the normal so they overlap rather than fight.
        const stack =
          (f.kind === 1 ? 0.012 : f.kind === 2 ? 0.02 : 0.004) *
          a *
          (1 + f.rank);
        for (let r = 0; r < ROWS; r++) {
          const u = r / (ROWS - 1);
          // A little cup and a little droop to the tip.
          const bend =
            (0.1 * u * u + 0.05 * Math.abs(this.beatRate) * u * u) * f.length;
          const half = outline(u) * f.width * 0.5;
          const centre: V3 = [
            root[0] + d[0] * f.length * u + n[0] * (stack - bend * 0.6),
            root[1] + d[1] * f.length * u + n[1] * (stack - bend * 0.6),
            root[2] + d[2] * f.length * u + n[2] * (stack - bend * 0.6),
          ];
          for (let e = 0; e < 2; e++) {
            const sgn = e === 0 ? -1 : 1;
            // Edges curl toward the normal side: a shallow trough.
            const curl = half * 0.3;
            const x = centre[0] + w[0] * half * sgn + n[0] * curl;
            const y = centre[1] + w[1] * half * sgn + n[1] * curl;
            const z = centre[2] + w[2] * half * sgn + n[2] * curl;
            // The left wing is the right's mirror image about the spine.
            pos[o] = this.root[0] - this.dx + sign * (this.dx + x);
            pos[o + 1] = this.root[1] + y;
            pos[o + 2] = this.root[2] + z;
            nor[o] = sign * n[0];
            nor[o + 1] = n[1];
            nor[o + 2] = n[2];
            o += 3;
          }
        }
      });
      const g = this.geometries[side];
      g.attributes.position.needsUpdate = true;
      g.attributes.normal.needsUpdate = true;
    }
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    this.group.removeFromParent();
  }
}
