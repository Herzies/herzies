/**
 * A cloak hung from a herzie's shoulders: real cloth, simulated.
 *
 * The way game capes are done (Unreal's Chaos Cloth, NvCloth, Unity's
 * Cloth), boiled down to what a herzie needs:
 *
 *  - XPBD, "small steps" (Macklin et al. 2016, 2019): a fixed 1/240 s
 *    substep with one constraint pass each, rather than a big step with many
 *    passes. Stiff cloth that stays stable, and the same however the frames
 *    land.
 *  - A garment cut from a flat pattern: the rest length of every thread is
 *    measured on the pattern (a flared trapezoid, its hem shaped per cloak),
 *    and wrapped round the back as a cone, so it starts unstrained.
 *  - Long-range attachments (Kim, Chentanez & Müller 2012): every particle
 *    may get no further from the collar than the pattern says. Cheap, and it
 *    is what keeps cloth from stretching like rubber when yanked.
 *  - Simulated in the herzie's own frame, feeling its moves as forces
 *    (gravity, less its acceleration; the turn's fling, its speeding up and
 *    Coriolis), scaled by a response (Chaos's linear and angular velocity
 *    scale), and clamped: a teleport, a portal's spin, a dropped frame never
 *    flings it across the map. thread-physics.ts does the same for the discs.
 *  - Air: each vertex is blown by the air it moves through, along its
 *    normal (a sail, not a pendulum): walking, it billows back; stopping, it
 *    swings on and falls; a little turbulence while moving makes it flutter.
 *  - Collision with the body's own primitives (capsules: a sphere is one
 *    with both ends together), each moved from last frame's pose to this
 *    one's across the substeps so a swinging leg can't pass through, with
 *    friction; and the ground, so a seated herzie's cloak pools. The
 *    rendered surface is pushed out of them once more (pushOutOfColliders):
 *    whatever falls between particles, nothing visible clips.
 *  - Straps: where gear is slung on the back over the cloak, the cloak is
 *    held flat against the body under it (see CloakInput.strap).
 *
 * No self-collision, as with most game capes: bending stiffness and the
 * body's colliders keep it from folding through itself.
 *
 * Creature space throughout (y down, front −z, so the back is +z), in
 * creature units. Pure, and allocation-free per step: HerzieModel owns a
 * CloakSim and steps it each frame.
 */

export type V3 = [number, number, number];

/** How a cloak is cut. */
export interface CloakShape {
  /** Particles across, and down. */
  cols: number;
  rows: number;
  /** Its length at the middle, collar to hem, as a fraction of the way from
   * the collar to the ground. */
  length: number;
  /** Half the angle its collar spans round the neck, radians (π/2: shoulder
   * to shoulder). */
  collarHalf: number;
  /** How much wider the hem is than the collar. */
  flare: number;
  /** The hem's cut. */
  hem: "round" | "dagged" | "straight" | "swallowtail";
  /** How much wider the cloth is cut than it hangs, gathered into pleats
   * at the collar (1: flat, no pleats). */
  gather: number;
}

/** How a cloak's cloth behaves. */
export interface CloakConfig {
  /** Pull of gravity, creature units/s² (+y is down). */
  gravity: number;
  /** How quickly its motion dies away, per second. */
  damping: number;
  /** How hard the air pushes on it, along its face, per unit speed². */
  drag: number;
  /** Air's drag along its face (much less than across it). */
  airFriction: number;
  /** How much of the herzie's speeding up, and of its turning, the cloth
   * feels, 0 to 1. */
  linearResponse: number;
  angularResponse: number;
  /** XPBD compliances (inverse stiffness): along its threads, across them
   * (shear), and against bending. 0 is rigid. */
  stretch: number;
  shear: number;
  bend: number;
  /** And against being gathered up shorter than it's cut: soft, so it
   * gives way to any push (see CloakRig.pairs) but springs back open — a
   * flared hem stays flared. */
  compress: number;
  /** Gusts while it's moving, as a fraction of its speed. */
  turbulence: number;
  /** Friction against the body (0 slides freely, 1 sticks). */
  friction: number;
  /** How hard its side edges are held in, in gravities: once out past a
   * line just off the herzie's flanks (HUG_REACH), they're drawn back to
   * it, so they lie flat down its sides, neither flared nor curled in. */
  hug: number;
}

export const DEFAULT_CLOAK_CONFIG: CloakConfig = {
  gravity: 21,
  damping: 6,
  drag: 1.95,
  airFriction: 0.88,
  linearResponse: 0.8,
  angularResponse: 0.7,
  stretch: 0,
  shear: 4e-3,
  bend: 4.5e-4,
  compress: 1.7e-3,
  turbulence: 0.02,
  friction: 0.47,
  hug: 5,
};

/** The body it hangs on, at rest. */
export interface CloakBody {
  /** The torso it's hung round, and the head above it. */
  body: { center: V3; radius: number };
  head: { center: V3; radius: number };
  /** Creature-space y of the ground under its feet. */
  ground: number;
}

/** A cloak cut for one herzie: its pattern, threads and collar. */
export interface CloakRig {
  cols: number;
  rows: number;
  /** Particle count, cols × rows; particle (c, r) is r * cols + c. */
  n: number;
  /** Where each particle hangs at rest, the body at rest (see settleCloak). */
  rest: Float32Array;
  /** Where each is on the pattern: across 0..1, down its column 0..1. */
  uv: Float32Array;
  /** 0 for the collar (pinned), 1 for the rest. */
  invMass: Float32Array;
  /** Threads: particle pairs, the longest and shortest each may be, and
   * what kind (0 along, 1 shear, 2 bend). Cloth never stretches but gathers
   * easily — real cloth buckles under the least push — so a thread pulls
   * only past its length and pushes only once gathered past its shortest
   * (NvCloth's compression limit). Without it, a cloak pinned round a curved
   * collar is as stiff as a curl of paper and can't swing. */
  pairs: Uint16Array;
  lengths: Float32Array;
  shortest: Float32Array;
  kinds: Uint8Array;
  /** How long each thread is as the cloak drapes (no longer than it's
   * cut): gathered any shorter, it's eased back to this, softly — the
   * drape's pleats and flare come back after a push. */
  drape: Float32Array;
  /** Each particle's long-range attachment: its collar particle, and how
   * far from it it may get. */
  tether: Uint16Array;
  tetherLength: Float32Array;
  /** The torso, at rest: a strap holds the cloth to it. */
  bodyCenter: V3;
  bodyRadius: number;
  /** How far the cloth keeps off what it touches. */
  margin: number;
  /** How far from the torso's middle strapped cloth may get. */
  strapRadius: number;
  /** Which way the pattern's face looks: +1 if (across × down) points out,
   * away from the body, else −1 (see cloakSurface). */
  outward: 1 | -1;
  /** How much each particle is drawn round toward the body (see
   * CloakConfig.hug): its side edges, 0 elsewhere. */
  hug: Float32Array;
  /** How far out each particle hangs from the torso's axis at rest, level:
   * the hug only draws cloth back to here, never further in. */
  hugReach: Float32Array;
}

/** What the cloth touches: capsules, 7 floats each — one end (x, y, z),
 * the other (x, y, z), radius. A sphere has both ends together. */
export type CloakColliders = Float32Array;
export const COLLIDER_STRIDE = 7;

/** What moves the herzie, this step (as ThreadInput). */
export interface CloakInput {
  /** How far the pose moves the torso from rest (its walk bob, its
   * dance): the collar rides it. */
  offset: V3;
  /** Its acceleration, creature units/s², creature space. */
  accel: V3;
  /** How fast it turns about its vertical, rad/s. */
  turnRate: number;
  /** How fast it's going, creature units/s, creature space. */
  velocity: V3;
  /** The body's primitives as posed now (see CloakColliders). */
  colliders: CloakColliders;
  /** Creature-space y of the ground: lower seated, further mid-jump. */
  ground: number;
  /** How hard slung gear holds the cloth to the back, 0 to 1 (0 with its
   * gear drawn), times each particle's own strap weight. */
  strap?: number;
}

export interface CloakSim {
  pos: Float32Array;
  prev: Float32Array;
  /** The colliders at the end of the last step, to sweep from. */
  colliders: Float32Array;
  /** Each particle's strap weight, 0 to 1 (set by the host from where its
   * gear is slung; zeros by default)… */
  strap: Float32Array;
  /** …and how far from the torso's middle a strap lets it get: no further
   * than it hangs at rest — the gear keeps it from billowing out from under
   * it, without pulling it anywhere it wouldn't lie. */
  strapReach: Float32Array;
  /** Turn rate at the last substep (eased, as thread-physics'). */
  turnRate: number;
  /** The torso's offset last step, and how fast it was moving. */
  offset: V3;
  bobVelocity: V3;
  /** Seconds simulated, for the gusts. */
  time: number;
  /** Seconds it's been still: past SLEEP_AFTER it's held still. */
  stillFor: number;
  /** Seconds the herzie's been still (not moving, not turning): the cloth
   * calms down quicker the longer it has been, as real cloth's own friction
   * stills it. */
  calmFor: number;
  /** Scratch: per-particle normals, and the colliders mid-sweep. */
  normals: Float32Array;
  swept: Float32Array;
}

// Small steps: fixed, so a long frame can't blow it up.
export const CLOAK_SUBSTEP = 1 / 240;
const MAX_SUBSTEPS = 24;
/** The most acceleration and turn the cloth feels (see thread-physics). */
const MAX_ACCEL = 30;
/** Falling, the cloth floats: at most this many of its own gravities are
 * taken off it — a little past weightless, so it drifts up through a hop
 * but never flips over the head, however light it's tuned. */
const MAX_FLOAT = 1.5;
/** Pressed down (taking off, landing): up to this, so a landing's jolt
 * flops it back down. */
const MAX_PRESS = 220;
const MAX_TURN = 9;
const TURN_EASE = 0.1;
const MAX_SPEED = 14;
/** Air's push is capped at this many gravities (a teleport's "wind"). */
const MAX_AIR = 3;
/** Moving less than this a substep is still, and held still once it has
 * been for SLEEP_AFTER seconds — so an idle view can stop drawing. */
const STILL = 4e-5;
const SLEEP_AFTER = 0.4;
/** How short (of its length) a thread may get before it pushes back: across
 * and down the cloth, diagonally, and folded over (see CloakRig.pairs). */
const GATHER_ACROSS = 0.6;
const GATHER_DOWN = 0.94;
const GATHER_SHEAR = 0.7;
const FOLD_ACROSS = 0.55;
const FOLD_DOWN = 0.75;
/** Still this long, the herzie's cloak calms: up to this much more damping
 * (per second), reached a second later. */
const CALM_AFTER = 0.8;
const CALM_DAMPING = 5;
/** The most a thread stretches, after strain limiting. */
const STRAIN = 0.015;
const STRAIN_ROUNDS = 2;
/** Columns to a pleat (see buildCloakRig). */
const PLEAT_COLUMNS = 4;
/** The side edges' hug reaches this far in from the middle (|across| 0..1):
 * the outer two columns or so. */
const HUG_FROM = 0.75;
/** How far past its rest line an edge goes before the hug pulls at full
 * strength (creature units). */
const HUG_SOFT = 0.06;
/** Where the hug draws the side edges in to, as a share of the torso's
 * radius (with the cloth's margin): just off the herzie's flanks. */
const HUG_REACH = 1.15;
/** Friction against the ground (see slow). */
const GROUND_FRICTION = 1.2;

/** Cuts a cloak for `body`: its collar round the back of the neck, just
 * under the head, and the pattern wrapped down the back as a cone. Settle
 * it (settleCloak) before use. */
export function buildCloakRig(
  shape: CloakShape,
  body: CloakBody,
  margin = 0.035,
): CloakRig {
  const { cols, rows } = shape;
  const n = cols * rows;
  const B = body.body.center;
  const H = body.head.center;
  const R = body.body.radius + margin;
  // Where the collar sits round the torso: as high as it can and still
  // clear the head (both centres on the creature's vertical). Distance from
  // the head's centre to a point on the torso at polar angle p (from the
  // top): R² + d² − 2dR·cos p.
  const d = Math.max(1e-6, B[1] - H[1]);
  const clear = body.head.radius + margin * 1.5;
  const cosMax = (R * R + d * d - clear * clear) / (2 * d * R);
  const polar = Math.acos(Math.max(-0.9, Math.min(0.95, cosMax))) + 0.06;
  const ring = R * Math.sin(polar);
  const collarY = B[1] - R * Math.cos(polar);
  const half = shape.collarHalf;
  // As it hangs (round the back)…
  const collarArc = 2 * half * ring;
  const hemArc = collarArc * shape.flare;
  // …and as it's cut: wider, gathered.
  const collarWidth = collarArc * shape.gather;
  const hemWidth = hemArc * shape.gather;
  const drop = Math.max(0.2, body.ground - collarY);
  const length = drop * shape.length;

  const across = (c: number) => (cols === 1 ? 0 : (c / (cols - 1)) * 2 - 1);
  const columnLength = (c: number) => length * hemProfile(shape.hem, c, cols);
  const width = (y: number) =>
    collarWidth + (hemWidth - collarWidth) * Math.min(1, y / length);
  // The pattern, flat: x across, y down its column.
  const flat = new Float32Array(n * 2);
  const uv = new Float32Array(n * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const t = rows === 1 ? 0 : r / (rows - 1);
      const y = t * columnLength(c);
      flat[i * 2] = (across(c) * width(y)) / 2;
      flat[i * 2 + 1] = y;
      uv[i * 2] = cols === 1 ? 0.5 : c / (cols - 1);
      uv[i * 2 + 1] = t;
    }
  }
  // Wrapped round as a cone: each column a straight line down its side, at
  // its own angle round the back, the cone's radius growing with the flare;
  // and pleated, in and out round it, deep enough that each row's pleated
  // arc is about as wide as the pattern's (a wave of depth A and length λ
  // runs 1 + (πA/λ)² times as long).
  const slope = (hemArc - collarArc) / (2 * half * length);
  const down = Math.sqrt(Math.max(0.05, 1 - slope * slope));
  const pleat = Math.sqrt(Math.max(0, shape.gather - 1)) / Math.PI;
  // The pleats' phase: each side edge in a fold's valley, on the cone —
  // never out on a crest, where it would flare away from the body.
  const mid = (cols - 1) / 2;
  const phase = Math.PI - (2 * Math.PI * mid) / PLEAT_COLUMNS;
  const rest = new Float32Array(n * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const y = flat[i * 2 + 1];
      const arc =
        (collarArc + (hemArc - collarArc) * Math.min(1, y / length)) /
        Math.max(1, cols - 1);
      const depth = pleat * arc * PLEAT_COLUMNS;
      // Folded outward only: the inside of every pleat rests on the cone.
      const rho =
        ring +
        slope * y +
        depth *
          (0.5 +
            0.5 * Math.cos((2 * Math.PI * c) / PLEAT_COLUMNS + phase));
      const phi = across(c) * half;
      rest[i * 3] = B[0] + rho * Math.sin(phi);
      rest[i * 3 + 1] = collarY + y * down;
      rest[i * 3 + 2] = B[2] + rho * Math.cos(phi);
    }
  }

  const invMass = new Float32Array(n).fill(1);
  for (let c = 0; c < cols; c++) invMass[c] = 0;
  // The side edges' hug: the outermost columns, more the further down.
  const hug = new Float32Array(n);
  for (let r = 1; r < rows; r++) {
    const t = rows === 1 ? 0 : r / (rows - 1);
    for (let c = 0; c < cols; c++) {
      const edge = Math.max(0, (Math.abs(across(c)) - HUG_FROM) / (1 - HUG_FROM));
      hug[r * cols + c] = edge * Math.min(1, t * 2.5);
    }
  }
  const hugReach = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    hugReach[i] = Math.min(
      Math.hypot(rest[i * 3] - B[0], rest[i * 3 + 2] - B[2]),
      R * HUG_REACH,
    );
  }

  const pairs: number[] = [];
  const kinds: number[] = [];
  const gathers: number[] = [];
  const add = (a: number, b: number, kind: number, gather: number) => {
    if (invMass[a] === 0 && invMass[b] === 0) return;
    pairs.push(a, b);
    kinds.push(kind);
    gathers.push(gather);
  };
  const at = (c: number, r: number) => r * cols + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Across, it gathers into folds; down, hardly at all.
      if (c + 1 < cols) add(at(c, r), at(c + 1, r), 0, GATHER_ACROSS);
      if (r + 1 < rows) add(at(c, r), at(c, r + 1), 0, GATHER_DOWN);
      if (c + 1 < cols && r + 1 < rows) {
        add(at(c, r), at(c + 1, r + 1), 1, GATHER_SHEAR);
        add(at(c + 1, r), at(c, r + 1), 1, GATHER_SHEAR);
      }
      // Bending: how far a fold may close before it pushes back.
      if (c + 2 < cols) add(at(c, r), at(c + 2, r), 2, FOLD_ACROSS);
      if (r + 2 < rows) add(at(c, r), at(c, r + 2), 2, FOLD_DOWN);
    }
  }
  const lengths = new Float32Array(kinds.length);
  const shortest = new Float32Array(kinds.length);
  for (let k = 0; k < kinds.length; k++) {
    const a = pairs[k * 2];
    const b = pairs[k * 2 + 1];
    lengths[k] = Math.hypot(
      flat[b * 2] - flat[a * 2],
      flat[b * 2 + 1] - flat[a * 2 + 1],
    );
    shortest[k] = lengths[k] * gathers[k];
  }
  const drape = new Float32Array(kinds.length);
  measureDrape(rest, pairs, lengths, drape);

  // Each particle's nearest collar point, on the pattern: as far as it may
  // ever get from it.
  const tether = new Uint16Array(n);
  const tetherLength = new Float32Array(n);
  for (let i = cols; i < n; i++) {
    let best = 0;
    let bestLength = Number.POSITIVE_INFINITY;
    for (let c = 0; c < cols; c++) {
      const l = Math.hypot(
        flat[i * 2] - flat[c * 2],
        flat[i * 2 + 1] - flat[c * 2 + 1],
      );
      if (l < bestLength) {
        bestLength = l;
        best = c;
      }
    }
    tether[i] = best;
    tetherLength[i] = bestLength;
  }

  // Which way the pattern faces, from the middle of the cloth.
  const mc = Math.floor(cols / 2);
  const mr = Math.floor(rows / 2);
  const p = (c: number, r: number, k: number) => rest[at(c, r) * 3 + k];
  const du: V3 = [0, 1, 2].map(
    (k) => p(Math.min(cols - 1, mc + 1), mr, k) - p(Math.max(0, mc - 1), mr, k),
  ) as V3;
  const dv: V3 = [0, 1, 2].map(
    (k) => p(mc, Math.min(rows - 1, mr + 1), k) - p(mc, Math.max(0, mr - 1), k),
  ) as V3;
  const face = crossV(du, dv);
  const out: V3 = [0, 1, 2].map((k) => p(mc, mr, k) - B[k]) as V3;
  const outward =
    face[0] * out[0] + face[1] * out[1] + face[2] * out[2] >= 0 ? 1 : -1;

  return {
    cols,
    rows,
    n,
    rest,
    uv,
    invMass,
    pairs: Uint16Array.from(pairs),
    lengths,
    shortest,
    kinds: Uint8Array.from(kinds),
    drape,
    tether,
    tetherLength,
    bodyCenter: [...B],
    bodyRadius: body.body.radius,
    margin,
    strapRadius: body.body.radius + margin * 1.6,
    outward,
    hug,
    hugReach,
  };
}

/** How long column `c` of `cols` runs, as a fraction of the middle's: the
 * hem's cut. */
export function hemProfile(
  hem: CloakShape["hem"],
  c: number,
  cols: number,
): number {
  const s = cols === 1 ? 0 : (c / (cols - 1)) * 2 - 1;
  switch (hem) {
    case "round":
      return 1 - 0.2 * s * s;
    case "straight":
      return 1 - 0.06 * s * s;
    case "dagged":
      // Points and notches, a point at each edge.
      return (1 - 0.08 * s * s) * (c % 2 === 0 ? 1 : 0.86);
    case "swallowtail":
      // Two long tails, a notch up the middle.
      return 0.74 + 0.3 * Math.abs(s) ** 0.7;
  }
}

function strapReachOf(rig: CloakRig): Float32Array {
  const out = new Float32Array(rig.n);
  const [bx, by, bz] = rig.bodyCenter;
  for (let i = 0; i < rig.n; i++) {
    const dx = rig.rest[i * 3] - bx;
    const dy = rig.rest[i * 3 + 1] - by;
    const dz = rig.rest[i * 3 + 2] - bz;
    out[i] = Math.max(
      rig.strapRadius,
      Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01,
    );
  }
  return out;
}

export function createCloakSim(rig: CloakRig): CloakSim {
  return {
    pos: rig.rest.slice(),
    prev: rig.rest.slice(),
    colliders: new Float32Array(0),
    strap: new Float32Array(rig.n),
    strapReach: strapReachOf(rig),
    turnRate: 0,
    offset: [0, 0, 0],
    bobVelocity: [0, 0, 0],
    time: 0,
    stillFor: 0,
    // It starts hanging at rest, as settleCloak left it.
    calmFor: CALM_AFTER + 1,
    normals: new Float32Array(rig.n * 3),
    swept: new Float32Array(0),
  };
}

/** Puts it back where it hangs at rest, on a torso moved `offset` — after
 * a teleport, a portal. */
export function resetCloak(
  sim: CloakSim,
  rig: CloakRig,
  offset: V3 = [0, 0, 0],
): void {
  for (let i = 0; i < rig.n; i++) {
    for (let k = 0; k < 3; k++) {
      sim.pos[i * 3 + k] = rig.rest[i * 3 + k] + offset[k];
    }
  }
  sim.prev.set(sim.pos);
  sim.offset = [...offset];
  sim.bobVelocity = [0, 0, 0];
  sim.turnRate = 0;
  sim.colliders = new Float32Array(0);
  sim.stillFor = 0;
  sim.calmFor = CALM_AFTER + 1;
}

/** Moves it along with the torso and nothing else: a cloak too far off to
 * be worth simulating (see HerzieModel's clothDetail). */
export function carryCloak(sim: CloakSim, rig: CloakRig, offset: V3): void {
  const dx = offset[0] - sim.offset[0];
  const dy = offset[1] - sim.offset[1];
  const dz = offset[2] - sim.offset[2];
  for (let i = 0; i < rig.n; i++) {
    sim.pos[i * 3] += dx;
    sim.pos[i * 3 + 1] += dy;
    sim.pos[i * 3 + 2] += dz;
  }
  sim.prev.set(sim.pos);
  sim.offset = [...offset];
  sim.bobVelocity = [0, 0, 0];
}

/** Advances it `dt` seconds, in substeps of `substep`. */
export function stepCloak(
  sim: CloakSim,
  rig: CloakRig,
  dt: number,
  input: CloakInput,
  config: CloakConfig = DEFAULT_CLOAK_CONFIG,
  substep = CLOAK_SUBSTEP,
): void {
  if (!(dt > 0)) return;
  const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / substep)));
  const h = dt / steps;
  const { n, cols, rows, invMass } = rig;
  const { pos, prev } = sim;

  // The torso's bob carries the cloth with it; its jolts are felt.
  const off = input.offset;
  const cx = off[0] - sim.offset[0];
  const cy = off[1] - sim.offset[1];
  const cz = off[2] - sim.offset[2];
  const bvx = cx / dt;
  const bvy = cy / dt;
  const bvz = cz / dt;
  const bax = (bvx - sim.bobVelocity[0]) / dt;
  const bay = (bvy - sim.bobVelocity[1]) / dt;
  const baz = (bvz - sim.bobVelocity[2]) / dt;
  sim.offset = [off[0], off[1], off[2]];
  sim.bobVelocity = [bvx, bvy, bvz];
  for (let i = 0; i < n; i++) {
    pos[i * 3] += cx;
    pos[i * 3 + 1] += cy;
    pos[i * 3 + 2] += cz;
    prev[i * 3] += cx;
    prev[i * 3 + 1] += cy;
    prev[i * 3 + 2] += cz;
  }
  // And what it touched last step, likewise: swept from there below, the
  // body would otherwise sweep in from where the torso was — through cloth
  // already carried past it — and fling it (a lunge moves the torso a
  // quarter of its girth a frame). Only what moves against the torso (an
  // arm swinging, a leg striding) sweeps.
  const last = sim.colliders;
  for (let o = 0; o + COLLIDER_STRIDE <= last.length; o += COLLIDER_STRIDE) {
    last[o] += cx;
    last[o + 1] += cy;
    last[o + 2] += cz;
    last[o + 3] += cx;
    last[o + 4] += cy;
    last[o + 5] += cz;
  }

  // What it feels of the herzie's moves.
  // Along the ground, a share of it (linearResponse). Up and down, all of
  // it, up to a jump's fall: falling, the cloak is weightless and floats.
  let ax = input.accel[0] + bax * 0.5;
  let az = input.accel[2] + baz * 0.5;
  const al = Math.sqrt(ax * ax + az * az);
  if (al > MAX_ACCEL) {
    ax *= MAX_ACCEL / al;
    az *= MAX_ACCEL / al;
  }
  ax *= config.linearResponse;
  az *= config.linearResponse;
  const ay = Math.max(
    -MAX_PRESS,
    Math.min(config.gravity * MAX_FLOAT, input.accel[1] + bay * 0.5),
  );
  // The air it goes through, in its own frame: the other way to its going.
  let wx = -input.velocity[0];
  let wy = -input.velocity[1];
  let wz = -input.velocity[2];
  const speed = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (speed > MAX_SPEED) {
    wx *= MAX_SPEED / speed;
    wy *= MAX_SPEED / speed;
    wz *= MAX_SPEED / speed;
  }
  const gust = Math.min(speed, MAX_SPEED) * config.turbulence;
  const turn =
    Math.max(-MAX_TURN, Math.min(MAX_TURN, input.turnRate)) *
    config.angularResponse;
  const center = rig.bodyCenter;
  const pcx = center[0] + off[0];
  const pcz = center[2] + off[2];
  const calm =
    Math.abs(input.turnRate) < 0.05 &&
    speed < 0.05 &&
    Math.hypot(...input.accel) < 0.5;
  sim.calmFor = calm ? sim.calmFor + dt : 0;
  const settling = Math.min(
    CALM_DAMPING,
    Math.max(0, sim.calmFor - CALM_AFTER) * CALM_DAMPING,
  );
  const keep = Math.exp(-(config.damping + settling) * h);
  const maxAir = MAX_AIR * config.gravity;
  const hugPull = (config.hug ?? 0) * config.gravity;

  // Colliders: swept from where they were to where they are.
  const now = input.colliders;
  const from = sim.colliders.length === now.length ? sim.colliders : now;
  const count = now.length / COLLIDER_STRIDE;
  if (sim.swept.length !== now.length) sim.swept = new Float32Array(now.length);
  const swept = sim.swept;

  const strapAt = input.strap ?? 0;
  const strapCx = center[0] + off[0];
  const strapCy = center[1] + off[1];
  const strapCz = center[2] + off[2];
  const margin = rig.margin;
  const friction = config.friction;
  const stiffAlong = config.stretch / (h * h);
  const stiffShear = config.shear / (h * h);
  const stiffBend = config.bend / (h * h);
  const stiffCompress = config.compress / (h * h);
  let moved = 0;

  for (let s = 0; s < steps; s++) {
    sim.time += h;
    const w =
      sim.turnRate + (turn - sim.turnRate) * (1 - Math.exp(-h / TURN_EASE));
    const spinUp = (w - sim.turnRate) / h;
    sim.turnRate = w;
    // The collar, carried with the torso, pinned.
    for (let c = 0; c < cols; c++) {
      pos[c * 3] = rig.rest[c * 3] + off[0];
      pos[c * 3 + 1] = rig.rest[c * 3 + 1] + off[1];
      pos[c * 3 + 2] = rig.rest[c * 3 + 2] + off[2];
      prev[c * 3] = pos[c * 3];
      prev[c * 3 + 1] = pos[c * 3 + 1];
      prev[c * 3 + 2] = pos[c * 3 + 2];
    }
    computeNormals(pos, cols, rows, rig.outward, sim.normals);
    const nrm = sim.normals;

    // Integrate (Verlet, damped).
    for (let i = cols; i < n; i++) {
      if (invMass[i] === 0) continue;
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      const vx = (x - prev[i * 3]) / h;
      const vy = (y - prev[i * 3 + 1]) / h;
      const vz = (z - prev[i * 3 + 2]) / h;
      // The herzie's frame turning about its vertical through the torso:
      // fling, lag as the turn speeds up, Coriolis.
      const rx = x - pcx;
      const rz = z - pcz;
      let fx = -ax + w * w * rx - spinUp * rz - 2 * w * vz;
      let fy = config.gravity - ay;
      let fz = -az + w * w * rz + spinUp * rx + 2 * w * vx;
      // The air through it, gusting a little while it moves: travelling
      // ripples across and down the cloth.
      const r = Math.floor(i / cols);
      const c = i - r * cols;
      const t = sim.time;
      const gx = wx + gust * Math.sin(t * 9.1 + r * 0.7 + c * 0.45) * 0.6;
      const gy = wy + gust * Math.sin(t * 6.3 - r * 0.9 + c * 0.3) * 0.35;
      const gz = wz + gust * Math.sin(t * 7.7 + r * 0.55 - c * 0.6) * 0.5;
      // Wind in the herzie's frame also sweeps round as it turns.
      const ux = vx - (gx - w * rz * 0.5);
      const uy = vy - gy;
      const uz = vz - (gz + w * rx * 0.5);
      const nx = nrm[i * 3];
      const ny = nrm[i * 3 + 1];
      const nz = nrm[i * 3 + 2];
      const un = ux * nx + uy * ny + uz * nz;
      const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
      // Across its face: the sail. Along it: a little skin friction.
      let airx =
        -config.drag * un * ul * nx - config.airFriction * (ux - un * nx);
      let airy =
        -config.drag * un * ul * ny - config.airFriction * (uy - un * ny);
      let airz =
        -config.drag * un * ul * nz - config.airFriction * (uz - un * nz);
      const am = Math.sqrt(airx * airx + airy * airy + airz * airz);
      if (am > maxAir) {
        airx *= maxAir / am;
        airy *= maxAir / am;
        airz *= maxAir / am;
      }
      fx += airx;
      fy += airy;
      fz += airz;
      // Its side edges kept from flaring: drawn back (level, toward the
      // axis) once out past where they hang at rest, never curled further
      // in, so they lie flat down the herzie's sides.
      const hw = rig.hug[i];
      if (hw > 0) {
        const rl = Math.sqrt(rx * rx + rz * rz);
        const out = rl - rig.hugReach[i];
        if (out > 0) {
          const pull = (hugPull * hw * Math.min(1, out / HUG_SOFT)) / rl;
          fx -= rx * pull;
          fz -= rz * pull;
        }
      }
      const h2 = h * h;
      prev[i * 3] = x;
      prev[i * 3 + 1] = y;
      prev[i * 3 + 2] = z;
      pos[i * 3] = x + vx * h * keep + fx * h2;
      pos[i * 3 + 1] = y + vy * h * keep + fy * h2;
      pos[i * 3 + 2] = z + vz * h * keep + fz * h2;
    }

    // Threads, one XPBD pass.
    const { pairs, lengths, shortest, kinds, drape } = rig;
    for (let k = 0; k < kinds.length; k++) {
      const a = pairs[k * 2];
      const b = pairs[k * 2 + 1];
      const wa = invMass[a];
      const wb = invMass[b];
      const dx = pos[b * 3] - pos[a * 3];
      const dy = pos[b * 3 + 1] - pos[a * 3 + 1];
      const dz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l < 1e-9) continue;
      const C =
        l > lengths[k] ? l - lengths[k] : l < shortest[k] ? l - shortest[k] : 0;
      const kind = kinds[k];
      // Gathered up, but not past its shortest: eased back open, softly.
      const gathered = C === 0 && l < drape[k];
      if (C === 0 && !gathered) continue;
      const alpha = gathered
        ? stiffCompress
        : kind === 0
          ? stiffAlong
          : kind === 1
            ? stiffShear
            : stiffBend;
      const dl = -(gathered ? l - drape[k] : C) / (wa + wb + alpha);
      const kx = (dx / l) * dl;
      const ky = (dy / l) * dl;
      const kz = (dz / l) * dl;
      pos[a * 3] -= wa * kx;
      pos[a * 3 + 1] -= wa * ky;
      pos[a * 3 + 2] -= wa * kz;
      pos[b * 3] += wb * kx;
      pos[b * 3 + 1] += wb * ky;
      pos[b * 3 + 2] += wb * kz;
    }

    // Long-range attachments: never further from the collar than cut.
    for (let i = cols; i < n; i++) {
      const a = rig.tether[i];
      const dx = pos[i * 3] - pos[a * 3];
      const dy = pos[i * 3 + 1] - pos[a * 3 + 1];
      const dz = pos[i * 3 + 2] - pos[a * 3 + 2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const max = rig.tetherLength[i];
      if (l <= max || l < 1e-9) continue;
      const k = max / l;
      pos[i * 3] = pos[a * 3] + dx * k;
      pos[i * 3 + 1] = pos[a * 3 + 1] + dy * k;
      pos[i * 3 + 2] = pos[a * 3 + 2] + dz * k;
    }

    // Strain limiting (Provot 1995): whatever the one pass above left
    // stretched under a hard yank, brought back to within STRAIN of its
    // length — cloth that reads as cloth, not elastic. Across a few times
    // (a spin flings the hem wide), then down each column last, following
    // the leader (Müller et al. 2012): the threads are listed from the
    // collar down, so moving only each lower end leaves none above it
    // stretched again.
    limitStrain(rig, pos, STRAIN_ROUNDS);

    // Held to the back under slung gear.
    if (strapAt > 0) {
      for (let i = cols; i < n; i++) {
        const sw = sim.strap[i] * strapAt;
        if (sw <= 0) continue;
        const dx = pos[i * 3] - strapCx;
        const dy = pos[i * 3 + 1] - strapCy;
        const dz = pos[i * 3 + 2] - strapCz;
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const reach = sim.strapReach[i];
        if (l <= reach || l < 1e-9) continue;
        const k = 1 - (sw * (l - reach)) / l;
        pos[i * 3] = strapCx + dx * k;
        pos[i * 3 + 1] = strapCy + dy * k;
        pos[i * 3 + 2] = strapCz + dz * k;
      }
    }

    // The body, where it is this substep, and the ground.
    const along = (s + 1) / steps;
    for (let j = 0; j < now.length; j++) {
      swept[j] = from[j] + (now[j] - from[j]) * along;
    }
    const floor = input.ground - margin;
    for (let i = cols; i < n; i++) {
      const under = pos[i * 3 + 1] - floor;
      if (under > 0) {
        pos[i * 3 + 1] = floor;
        // Lying on the ground, it drags (rougher than the body).
        slow(pos, prev, i * 3, 0, -1, 0, GROUND_FRICTION * under);
      }
      // Twice: where the body's parts overlap, out of one can be into
      // another.
      collide(pos, prev, i, swept, count, margin, friction);
      collide(pos, prev, i, swept, count, margin, 0);
    }
    // A leg's kick moves one bit of hem, which pulls its threads long: they
    // pull the rest along, and the body has the last word again. (Only on
    // the move: at rest, the two would nudge it round and round for good.)
    if (count > 0 && sim.calmFor < CALM_AFTER) {
      limitStrain(rig, pos, 1);
      for (let i = cols; i < n; i++) {
        collide(pos, prev, i, swept, count, margin, 0);
      }
    }
  }

  // Never let a bad frame poison it.
  for (let i = 0; i < n * 3; i++) {
    if (!Number.isFinite(pos[i])) {
      resetCloak(sim, rig, off);
      keepColliders(sim, now);
      return;
    }
    const d = Math.abs(pos[i] - prev[i]);
    if (d > moved) moved = d;
  }
  keepColliders(sim, now);
  // Asleep once it's been still a moment: held exactly where it is.
  if (moved < STILL && Math.abs(input.turnRate) < 1e-3 && speed < 1e-3) {
    sim.stillFor += dt;
    if (sim.stillFor >= SLEEP_AFTER) sim.prev.set(sim.pos);
  } else {
    sim.stillFor = 0;
  }
}

/** Strain limiting, `rounds` times over (see stepCloak). */
function limitStrain(rig: CloakRig, pos: Float32Array, rounds: number) {
  const { pairs, lengths, kinds, invMass, cols } = rig;
  for (let pass = 0; pass < rounds * 3; pass++) {
    // Each round: across twice, then down.
    const down = pass % 3 === 2;
    for (let k = 0; k < kinds.length; k++) {
      if (kinds[k] !== 0) continue;
      const a = pairs[k * 2];
      const b = pairs[k * 2 + 1];
      if ((b - a === cols) !== down) continue;
      const wa = invMass[a];
      const wb = invMass[b];
      const dx = pos[b * 3] - pos[a * 3];
      const dy = pos[b * 3 + 1] - pos[a * 3 + 1];
      const dz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const max = lengths[k] * (1 + STRAIN);
      if (l <= max) continue;
      if (down) {
        const kk = (l - max) / l;
        pos[b * 3] -= dx * kk;
        pos[b * 3 + 1] -= dy * kk;
        pos[b * 3 + 2] -= dz * kk;
        continue;
      }
      const kk = (l - max) / (l * (wa + wb));
      pos[a * 3] += wa * dx * kk;
      pos[a * 3 + 1] += wa * dy * kk;
      pos[a * 3 + 2] += wa * dz * kk;
      pos[b * 3] -= wb * dx * kk;
      pos[b * 3 + 1] -= wb * dy * kk;
      pos[b * 3 + 2] -= wb * dz * kk;
    }
  }
}

function keepColliders(sim: CloakSim, now: Float32Array) {
  if (sim.colliders.length !== now.length) {
    sim.colliders = new Float32Array(now.length);
  }
  sim.colliders.set(now);
}

/** Nothing on the cloak is moving to speak of. */
export function isCloakSettled(sim: CloakSim): boolean {
  return sim.stillFor >= SLEEP_AFTER;
}

/** The cloak where it hangs at rest, nothing moving it: what the model is
 * built with, so a still view shows it as it'd really hang. `colliders` is
 * the body at rest. */
export function settleCloak(
  rig: CloakRig,
  colliders: CloakColliders,
  ground: number,
  config: CloakConfig = DEFAULT_CLOAK_CONFIG,
  seconds = 5,
): void {
  const sim = createCloakSim(rig);
  const still: CloakInput = {
    offset: [0, 0, 0],
    accel: [0, 0, 0],
    turnRate: 0,
    velocity: [0, 0, 0],
    colliders,
    ground,
  };
  const step = 1 / 30;
  // Twice: once hung, the drape it ends up in is what it eases back to,
  // and that moves it a little again.
  for (const share of [1, 0.7]) {
    for (let t = 0; t < seconds * share; t += step) {
      stepCloak(sim, rig, step, still, config);
      // Not asleep till it's really there.
      sim.stillFor = 0;
      // Heavily damped at first: only where it ends up matters. Then let
      // be, so it comes to rest the way it will when worn.
      if (share < 1) continue;
      for (let i = 0; i < sim.pos.length; i++) {
        sim.prev[i] += (sim.pos[i] - sim.prev[i]) * 0.25;
      }
    }
    measureDrape(sim.pos, rig.pairs, rig.lengths, rig.drape);
  }
  rig.rest.set(sim.pos);
}

/** Each thread's length as `rest` drapes, at most its cut length. */
function measureDrape(
  rest: Float32Array,
  pairs: ArrayLike<number>,
  lengths: Float32Array,
  out: Float32Array,
) {
  for (let k = 0; k < lengths.length; k++) {
    const a = pairs[k * 2];
    const b = pairs[k * 2 + 1];
    const l = Math.hypot(
      rest[b * 3] - rest[a * 3],
      rest[b * 3 + 1] - rest[a * 3 + 1],
      rest[b * 3 + 2] - rest[a * 3 + 2],
    );
    out[k] = Math.min(lengths[k], l);
  }
}

/** Pushes each point of `points` (x, y, z, …) out of the colliders, to
 * `margin` off their surface: the drawn surface, whatever falls between the
 * particles. */
export function pushOutOfColliders(
  points: Float32Array,
  colliders: CloakColliders,
  margin: number,
): void {
  const count = colliders.length / COLLIDER_STRIDE;
  // Twice over: out of one overlapping part can be into another.
  for (let p = 0; p < points.length; p += 3) {
    for (let j = 0; j < count * 2; j++) {
      const o = (j % count) * COLLIDER_STRIDE;
      const q = closestOnSegment(points, p, colliders, o);
      const dx = points[p] - q[0];
      const dy = points[p + 1] - q[1];
      const dz = points[p + 2] - q[2];
      const want = colliders[o + 6] + margin;
      const l2 = dx * dx + dy * dy + dz * dz;
      if (l2 >= want * want) continue;
      const l = Math.sqrt(l2);
      if (l < 1e-9) continue;
      const k = want / l;
      points[p] = q[0] + dx * k;
      points[p + 1] = q[1] + dy * k;
      points[p + 2] = q[2] + dz * k;
    }
  }
}

/**
 * The drawn surface: the particle grid smoothed (Catmull–Rom, `sub` points
 * a span, so ((cols − 1)·sub + 1) × ((rows − 1)·sub + 1) of them) into
 * `out`. Its normals come later, from the pushed-out points (cloakNormals).
 */
export function cloakSurface(
  pos: Float32Array,
  cols: number,
  rows: number,
  sub: number,
  out: Float32Array,
  scratch: Float32Array,
): void {
  const rc = (cols - 1) * sub + 1;
  // Across each row first, into scratch (rows × rc)…
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < rc; x++) {
      const span = Math.min(cols - 2, Math.floor(x / sub));
      const t = x / sub - span;
      for (let k = 0; k < 3; k++) {
        const p = (c: number) =>
          pos[(r * cols + Math.max(0, Math.min(cols - 1, c))) * 3 + k];
        scratch[(r * rc + x) * 3 + k] = catmullRom(
          p(span - 1),
          p(span),
          p(span + 1),
          p(span + 2),
          t,
        );
      }
    }
  }
  // …then down each column.
  const rr = (rows - 1) * sub + 1;
  for (let y = 0; y < rr; y++) {
    const span = Math.min(rows - 2, Math.floor(y / sub));
    const t = y / sub - span;
    for (let x = 0; x < rc; x++) {
      for (let k = 0; k < 3; k++) {
        const p = (r: number) =>
          scratch[(Math.max(0, Math.min(rows - 1, r)) * rc + x) * 3 + k];
        out[(y * rc + x) * 3 + k] = catmullRom(
          p(span - 1),
          p(span),
          p(span + 1),
          p(span + 2),
          t,
        );
      }
    }
  }
}

/** Normals of a grid of points (`w` across, `hgt` down), pointing the
 * pattern's outward way (`outward`, see CloakRig). */
export function cloakNormals(
  points: Float32Array,
  w: number,
  hgt: number,
  outward: 1 | -1,
  out: Float32Array,
): void {
  computeNormals(points, w, hgt, outward, out);
}

function computeNormals(
  p: Float32Array,
  w: number,
  hgt: number,
  outward: 1 | -1,
  out: Float32Array,
) {
  for (let y = 0; y < hgt; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(hgt - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(w - 1, x + 1);
      const a = (y * w + x1) * 3;
      const b = (y * w + x0) * 3;
      const c = (y1 * w + x) * 3;
      const d = (y0 * w + x) * 3;
      const ux = p[a] - p[b];
      const uy = p[a + 1] - p[b + 1];
      const uz = p[a + 2] - p[b + 2];
      const vx = p[c] - p[d];
      const vy = p[c + 1] - p[d + 1];
      const vz = p[c + 2] - p[d + 2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) * outward;
      if (Math.abs(l) < 1e-12) {
        nx = 0;
        ny = 0;
        nz = outward;
      } else {
        nx /= l;
        ny /= l;
        nz /= l;
      }
      const o = (y * w + x) * 3;
      out[o] = nx;
      out[o + 1] = ny;
      out[o + 2] = nz;
    }
  }
}

function catmullRom(a: number, b: number, c: number, d: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * b +
      (c - a) * t +
      (2 * a - 5 * b + 4 * c - d) * t2 +
      (3 * b - a - 3 * c + d) * t3)
  );
}

const closest: V3 = [0, 0, 0];
/** The nearest point to points[p..p+3] on collider `o`'s segment. */
function closestOnSegment(
  points: Float32Array,
  p: number,
  col: Float32Array,
  o: number,
): V3 {
  const ax = col[o];
  const ay = col[o + 1];
  const az = col[o + 2];
  const bx = col[o + 3] - ax;
  const by = col[o + 4] - ay;
  const bz = col[o + 5] - az;
  const ll = bx * bx + by * by + bz * bz;
  let t = 0;
  if (ll > 1e-12) {
    t =
      ((points[p] - ax) * bx +
        (points[p + 1] - ay) * by +
        (points[p + 2] - az) * bz) /
      ll;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  closest[0] = ax + bx * t;
  closest[1] = ay + by * t;
  closest[2] = az + bz * t;
  return closest;
}

function collide(
  pos: Float32Array,
  prev: Float32Array,
  i: number,
  col: Float32Array,
  count: number,
  margin: number,
  friction: number,
) {
  const p = i * 3;
  for (let j = 0; j < count; j++) {
    const o = j * COLLIDER_STRIDE;
    const q = closestOnSegment(pos, p, col, o);
    const dx = pos[p] - q[0];
    const dy = pos[p + 1] - q[1];
    const dz = pos[p + 2] - q[2];
    const want = col[o + 6] + margin;
    const l2 = dx * dx + dy * dy + dz * dz;
    if (l2 >= want * want) continue;
    const l = Math.sqrt(l2);
    // Dead centre: out the back.
    const nx = l < 1e-9 ? 0 : dx / l;
    const ny = l < 1e-9 ? 0 : dy / l;
    const nz = l < 1e-9 ? 1 : dz / l;
    pos[p] = q[0] + nx * want;
    pos[p + 1] = q[1] + ny * want;
    pos[p + 2] = q[2] + nz * want;
    // Coulomb friction, position-based (Macklin et al. 2014): what it slid
    // along the surface this substep is cut by at most μ × how far in it was
    // pressed — the harder it's pushed against the body, the more it holds.
    slow(pos, prev, p, nx, ny, nz, friction * (want - l));
  }
}

/** Cuts the slide along a surface (normal n) of particle `p` this substep
 * by up to `limit`. */
function slow(
  pos: Float32Array,
  prev: Float32Array,
  p: number,
  nx: number,
  ny: number,
  nz: number,
  limit: number,
) {
  const vx = pos[p] - prev[p];
  const vy = pos[p + 1] - prev[p + 1];
  const vz = pos[p + 2] - prev[p + 2];
  const vn = vx * nx + vy * ny + vz * nz;
  const tx = vx - vn * nx;
  const ty = vy - vn * ny;
  const tz = vz - vn * nz;
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (tl < 1e-12) return;
  const k = Math.min(tl, limit) / tl;
  pos[p] -= tx * k;
  pos[p + 1] -= ty * k;
  pos[p + 2] -= tz * k;
}

function crossV(a: V3, b: V3): V3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
