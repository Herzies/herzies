import * as THREE from "three";
import {
  buildCloakRig,
  CLOAK_SUBSTEP,
  type CloakColliders,
  type CloakConfig,
  type CloakRig,
  type CloakSim,
  type V3 as CloakV3,
  carryCloak,
  cloakNormals,
  cloakSurface,
  createCloakSim,
  isCloakSettled,
  pushOutOfColliders,
  resetCloak,
  settleCloak,
  stepCloak,
} from "../cloak-physics.js";
import {
  CLOTH_FINISH,
  type CloakStyle,
  cloakBodyOf,
  cloakColliderParts,
  cloakColliders,
  cloakStyleFor,
} from "../cloaks.js";
import {
  buildCreatureModel,
  CAST,
  CAST_ARM,
  CATCH_SECONDS,
  type CastStyle,
  CREATURE_FRAME_HEIGHT,
  type CreatureModel,
  type CreatureMotion,
  type CreatureParams,
  castHand,
  castWeight,
  creaturePoseOffsets,
  creatureSeatDrop,
  DANCE_LOOP_FRAMES,
  danceHopLift,
  dangledAxis,
  HELD_ARM,
  hasDangleEquipped,
  heldPoses,
  heldSwing,
  primitiveShading,
  type Sphere,
  schemeShades,
  schemeSpan,
} from "../creature-renderer.js";
import {
  createDangleSim,
  type DangleConfig,
  type DangleSim,
  type DangleState,
  DEFAULT_DANGLE_CONFIG,
  dangleState,
  isDangleSettled,
  stepDangle,
} from "../dangle-physics.js";
import type { Equipped } from "../items.js";
import {
  createThreadSim,
  DEFAULT_THREAD_CONFIG,
  isThreadSettled,
  stepThreadSim,
  type ThreadConfig,
  type ThreadRig,
  type ThreadSim,
  threadSway,
} from "../thread-physics.js";
import {
  type AnimationState,
  IDLE_FPS,
  newAnimationState,
  stepAnimation,
} from "./animation.js";
import {
  type CompanionHost,
  type CompanionState,
  newCompanionState,
  seededRandom,
  stepCompanion,
} from "./companion.js";
import {
  type HerzieLighting,
  herzieMaterial,
  type SchemeUniforms,
} from "./herzieMaterial.js";
import {
  GHOST_SURGE,
  newSurgeState,
  SPIRIT_SURGE,
  type SurgeState,
  type SurgeTuning,
  stepSurge,
} from "./surge.js";

/** Which herzie, and dressed how. */
export type HerzieLook = {
  /** The render seed: a herzie's friend code, or an NPC's own seed. */
  seed: string;
  stage: number;
  equipped?: Equipped;
  /** Hand-set params instead of the seed's (the boss). */
  params?: CreatureParams;
};

export type HerzieModelOptions = {
  /** Staggers the idle loop, so a crowd doesn't breathe in unison. */
  seed?: number;
  /** Default: studioLighting. The Town passes its day cycle's. */
  lighting?: HerzieLighting;
  /** The grid props at the frame's edge (a floating pet, the boombox) are
   * placed against: the one the old renderer drew this herzie on, so they
   * keep their spot. Default 64 x 64 (the Town's). */
  layoutCols?: number;
  layoutRows?: number;
  /** Keep ground props (the boombox) and floating companions (a spirit, a
   * pet) where the old renderer put them, turned this far (0: as it drew
   * them, unturned — any other turn swings the corner props toward or away
   * from the camera, one side nearer than the other), instead of turning
   * with the herzie: a herzie spun on its own stage, not one walking about.
   * Default: they go with it (the Town). */
  anchorScenery?: number;
  /** Starts with its class gear already drawn (and `armed`), rather than
   * drawing it off its back on the first frames. */
  armed?: boolean;
};

/** The old renderer's dance loop: 65ms a frame. */
const DANCE_FPS = 1000 / 65;
/** How quickly dancing fades in and out, per second. */
const DANCE_BLEND_RATE = 6;
/** How quickly it sits down and stands up (per second). */
const SIT_BLEND_RATE = 14;
/** A jump: how high it hops, in world units (a herzie is ~4.5 tall), and
 * how long it's off the ground — quick, so it reads as a hop. */
export const JUMP_HEIGHT = 0.85;
export const JUMP_AIR_SECONDS = 0.36;
const JUMP_GRAVITY = (8 * JUMP_HEIGHT) / JUMP_AIR_SECONDS ** 2;
const JUMP_SPEED = (4 * JUMP_HEIGHT) / JUMP_AIR_SECONDS;
/** A press this soon before landing jumps again on touchdown. */
const JUMP_BUFFER_SECONDS = 0.12;
/** The squash it lands with, and how long it takes to spring back. */
const LAND_SQUASH = 0.14;
const LAND_SECONDS = 0.16;
/** How far it stretches at full speed up or down, eased in at takeoff. */
const AIR_STRETCH = 0.1;
const TAKEOFF_SECONDS = 0.05;
/** How long a sonic cast takes, draw to home again, in seconds. The wave
 * leaves the hand CAST.release of the way through. */
export const CAST_SECONDS = 0.4;
/** How soon after cast() the wave leaves the hand, in seconds. */
export const CAST_RELEASE_SECONDS = CAST_SECONDS * CAST.release;
/** How long a blow that lands holds still (see hitstop), in seconds: long
 * enough for the eye to catch the contact, short enough not to drag. */
export const HITSTOP_SECONDS = 0.07;
/** How long it takes to draw its class gear off its back, in seconds:
 * quick — it's what stands between Tab and the first cast. */
export const DRAW_SECONDS = 0.25;
/** How long putting it away takes. Nothing waits on it, so it can be easy. */
export const SHEATHE_SECONDS = 0.35;
/** How long after it stops aiming before it puts its gear away, in seconds:
 * aiming again inside this, it's still in hand. */
export const SHEATHE_DELAY = 0.25;
/** Faster than this (world units/s) between frames, it jumped rather than
 * moved: the threads don't feel it. */
const THREAD_JUMP_SPEED = 60;
/** Time constant (s) its velocity is smoothed over for the threads. */
const THREAD_SMOOTHING = 0.12;
/** How many drawn points a cloak's particle span is smoothed into
 * (cloakSurface). */
const CLOAK_SMOOTHING = 3;
/** How far the drawn cloth keeps off the body (creature units): under the
 * particles' own margin, so the push only catches what falls between. */
const CLOAK_DRAWN_MARGIN = 0.02;
/** A cloak's settled drape, by body and cloak: every herzie of a shape
 * shares one, so the Town can build a crowd without settling each. */
const settledCloaks = new Map<
  string,
  { rest: Float32Array; drape: Float32Array }
>();

/** How much a cloak is simulated (see HerzieModel.clothDetail). */
export type ClothDetail = "full" | "half" | "frozen";

/** A herzie with no arms (stage 1) grows a little hand to cast with: this
 * big, as a fraction of its head. */
const POP_HAND = 0.3;
/** World units per creature unit: the renderer's whole frame (at the
 * herzie's centre) is 4.5 world units tall, the size the sprites were. */
export const MODEL_SCALE = 4.5 / CREATURE_FRAME_HEIGHT;

/** Parts anchored beside the herzie rather than on it (see the renderer's
 * isSceneFixed): they don't count toward where it stands or how tall it is. */
const floats = (s: Sphere) => s.part === "spirit" || s.part === "pet";
/** What the old renderer kept still while the herzie turned. */
const sceneFixed = (s: Sphere) => floats(s) || s.part === "ground";

/** Air between a floating companion and the herzie, in creature units. */
const COMPANION_GAP = 0.15;
/** A surging companion stretches up as it rises and squashes as it sinks
 * (keeping its volume): this much per creature unit a second, at most
 * SURGE_MAX_STRETCH. */
const SURGE_STRETCH = 0.05;
const SURGE_MAX_STRETCH = 0.07;
/** And tips back as it rises (radians per creature unit a second), at most
 * SURGE_MAX_TILT. */
const SURGE_TILT = 0.1;
const SURGE_MAX_TILT = 0.12;

// Geometries are shared between herzies, cached by size, and kept for the
// app's lifetime: there are only a handful of distinct ones.
const UNIT_SPHERE = new THREE.SphereGeometry(1, 20, 14);
const geometries = new Map<string, THREE.BufferGeometry>();
const UP = new THREE.Vector3(0, 1, 0);
const scratch = new THREE.Vector3();
const scratchScale = new THREE.Vector3();

/** A string's hash, to seed something by it. */
function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/**
 * A floating companion that flies about after the herzie on its own (see
 * companion.ts), rather than riding along on it.
 */
type Follower = {
  /** In root space, moved to wherever the companion is in the world. */
  group: THREE.Group;
  /** Turns and leans it, by its own heading. */
  yaw: THREE.Group;
  /** Undoes the turn placeCompanion gave it, so it faces the yaw's way. */
  facing: THREE.Group;
  state: CompanionState;
  host: CompanionHost;
};

/**
 * Lays out a follower for the companion's parts, with its core (its biggest
 * part) at the group's origin, and where it rests beside the herzie.
 */
function makeFollower(
  spheres: Sphere[],
  feetY: number,
  seed: number,
): Follower | null {
  const parts = spheres.filter(floats);
  if (parts.length === 0) return null;
  let core = parts[0];
  for (const s of parts) if (s.radius > core.radius) core = s;
  const [cx, cy, cz] = core.center;
  // Its front: where its features (eyes, a mouth) sit off its core. In
  // creature space front is −z; turned upright, (x, −z) on the ground.
  let fx = 0;
  let fz = 0;
  let reachOut = 0;
  for (const s of parts) {
    const dx = s.center[0] - cx;
    const dz = s.center[2] - cz;
    fx += dx;
    fz += dz;
    reachOut = Math.max(reachOut, Math.hypot(dx, dz) + s.radius);
  }
  let bodyReach = 0;
  for (const s of spheres) {
    if (floats(s) || s.part === "ground") continue;
    bodyReach = Math.max(
      bodyReach,
      Math.hypot(s.center[0], s.center[2]) + s.radius,
    );
  }
  const rest = Math.hypot(cx, cz);
  const group = new THREE.Group();
  const yaw = new THREE.Group();
  const facing = new THREE.Group();
  const restHeading = Math.atan2(fx, -fz);
  facing.rotation.y = -restHeading;
  group.add(yaw);
  yaw.add(facing);
  return {
    group,
    yaw,
    facing,
    state: newCompanionState(seed),
    host: {
      position: new THREE.Vector3(),
      heading: 0,
      scale: 1,
      slot: new THREE.Vector3(
        cx * MODEL_SCALE,
        (feetY - cy) * MODEL_SCALE,
        -cz * MODEL_SCALE,
      ),
      clearance: Math.min(rest, bodyReach + reachOut * 0.8) * MODEL_SCALE,
    },
  };
}

function cached(key: string, make: () => THREE.BufferGeometry) {
  let g = geometries.get(key);
  if (!g) {
    g = make();
    geometries.set(key, g);
  }
  return g;
}

/** A cylinder along y, `h` either side of the middle, its flat ends bulged
 * out by `dome` (or dished in, negative) as a paraboloid, like the ray
 * caster's. The rim is doubled so the side and ends meet on a hard edge. */
function domedCylinder(r: number, h: number, dome: number) {
  const steps = 8;
  const end = (sign: number) => {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= steps; i++) {
      const rho = (r * i) / steps;
      pts.push(
        new THREE.Vector2(rho, sign * (h + dome * (1 - (rho * rho) / (r * r)))),
      );
    }
    return pts;
  };
  // Bottom end from the axis out, up the side, then the top end back in.
  // Each rim point is doubled: the zero-length segment between the copies
  // gives one the end's normal and the other the side's.
  const bottom = end(-1);
  const top = end(1).reverse();
  const profile = [
    ...bottom,
    bottom[bottom.length - 1].clone(),
    top[0].clone(),
    ...top,
  ];
  return new THREE.LatheGeometry(profile, 24);
}

/** A worn cloak: its cloth and what draws it. */
type CloakRun = {
  style: CloakStyle;
  rig: CloakRig;
  sim: CloakSim;
  /** The parts its cloth touches, and its head and torso, by index. */
  parts: number[];
  headAt: number;
  bodyAt: number;
  colliders: CloakColliders;
  /** The same at the arms' full size, as they're drawn: what the drawn
   * cloth is kept out of. */
  drawnColliders: CloakColliders;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  /** The drawn surface (the geometry's positions), the smoothing's scratch,
   * and its normals; `width` × `height` points. */
  surface: Float32Array;
  scratch: Float32Array;
  normals: Float32Array;
  width: number;
  height: number;
  clasps: THREE.Mesh[];
  /** Its body in the world last frame, and how fast it was going. */
  lastWorld: THREE.Vector3 | null;
  worldVelocity: THREE.Vector3;
};

/** Cuts `style`'s cloak for this body and hangs it where it settles (one
 * settling per body and cloak, shared). Null without a torso and head. */
function cutCloak(style: CloakStyle, spheres: Sphere[], feetY: number) {
  const found = cloakBodyOf(spheres, feetY);
  if (!found) return null;
  const { cloakBody, headAt, bodyAt } = found;
  const parts = cloakColliderParts(spheres);
  const rig = buildCloakRig(style.shape, cloakBody);
  // Keyed on the body's shape, measured from its torso: herzies differ by
  // where the frame centres them far more often than by shape.
  const origin = spheres[bodyAt].center;
  const k = (n: number) => n.toFixed(3);
  const key = [
    JSON.stringify(style.shape),
    JSON.stringify(style.config),
    k(feetY - origin[1]),
    ...parts.map((i) => {
      const s = spheres[i];
      const at = s.center.map((v, j) => k(v - origin[j])).join(",");
      return `${s.part}:${at}:${k(s.radius)}`;
    }),
  ].join("|");
  let settled = settledCloaks.get(key);
  if (!settled) {
    const atRest = cloakColliders(
      spheres,
      parts,
      headAt,
      bodyAt,
      (i) => spheres[i].center as CloakV3,
    );
    settleCloak(rig, atRest, feetY, style.config);
    const rest = rig.rest.slice();
    for (let i = 0; i < rest.length; i++) rest[i] -= origin[i % 3];
    settled = { rest, drape: rig.drape.slice() };
    settledCloaks.set(key, settled);
  }
  for (let i = 0; i < rig.rest.length; i++) {
    rig.rest[i] = settled.rest[i] + origin[i % 3];
  }
  rig.drape.set(settled.drape);
  return { rig, parts, headAt, bodyAt };
}

/**
 * Moves a floating companion (a spirit, a pet) to hover beside the herzie,
 * clear of its body. The renderer places one in front of the herzie at the
 * flat frame's edge, which in a 3D world puts it half inside the body.
 */
function besideHerzie(spheres: Sphere[]) {
  const companion = spheres.filter(floats);
  if (companion.length === 0) return;
  let bodyRight = Number.NEGATIVE_INFINITY;
  for (const s of spheres) {
    if (!floats(s)) bodyRight = Math.max(bodyRight, s.center[0] + s.radius);
  }
  let left = Number.POSITIVE_INFINITY;
  let cz = 0;
  for (const s of companion) {
    left = Math.min(left, s.center[0] - s.radius);
    cz += s.center[2] / companion.length;
  }
  const dx = bodyRight + COMPANION_GAP - left;
  for (const s of companion) {
    s.center = [s.center[0] + dx, s.center[1], s.center[2] - cz];
  }
}

/** How much wider and taller a surging companion is, rising at `v`
 * (creature units a second): taller rising, squatter sinking, its volume
 * kept. */
function surgeStretch(v: number): [number, number] {
  const tall =
    1 +
    THREE.MathUtils.clamp(
      v * SURGE_STRETCH,
      -SURGE_MAX_STRETCH,
      SURGE_MAX_STRETCH,
    );
  return [1 / Math.sqrt(tall), tall];
}

/** The arms that draw class gear. */
const ARM_OF_HELD = new Set(Object.values(HELD_ARM));
const add3 = (a: readonly number[], b: readonly number[]) =>
  [a[0] + b[0], a[1] + b[1], a[2] + b[2]] as [number, number, number];

/** How far a part reaches from its centre, whatever its shape. */
function reach(s: Sphere): number {
  if (!s.shape) return s.radius;
  return Math.hypot(...s.shape.axis) + s.radius + Math.abs(s.shape.dome ?? 0);
}

/** A sphere round every part at any turn (see HerzieModel.bounds), with
 * room for the poses to move them a little. */
function turnBounds(spheres: Sphere[], feetY: number): THREE.Sphere {
  // Root space: up is −y in creature space, measured from the feet.
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const s of spheres) {
    const y = feetY - s.center[1];
    lo = Math.min(lo, y - reach(s));
    hi = Math.max(hi, y + reach(s));
  }
  const cy = (lo + hi) / 2;
  let r = 0;
  for (const s of spheres) {
    const d = Math.hypot(s.center[0], feetY - s.center[1] - cy, s.center[2]);
    r = Math.max(r, d + reach(s));
  }
  return new THREE.Sphere(
    new THREE.Vector3(0, cy * MODEL_SCALE, 0),
    r * MODEL_SCALE * 1.15,
  );
}

function geometryFor(s: Sphere): THREE.BufferGeometry {
  const shape = s.shape;
  if (!shape) return UNIT_SPHERE;
  const h = Math.hypot(...shape.axis);
  const r = s.radius;
  const k = (n: number) => n.toFixed(4);
  if (shape.kind === "capsule") {
    return cached(
      `capsule:${k(r)}:${k(h)}`,
      () => new THREE.CapsuleGeometry(r, 2 * h, 6, 16),
    );
  }
  if (shape.kind === "cone") {
    const tip = shape.tipRadius ?? 0;
    // CylinderGeometry's top is +y, which the mesh turns onto +axis.
    return cached(
      `cone:${k(r)}:${k(tip)}:${k(h)}`,
      () => new THREE.CylinderGeometry(tip, r, 2 * h, 24),
    );
  }
  const dome = shape.dome ?? 0;
  return cached(`cylinder:${k(r)}:${k(h)}:${k(dome)}`, () =>
    domedCylinder(r, h, dome),
  );
}

/**
 * A herzie standing in the 3D Town, built from the same primitives the
 * ray caster draws (spheres, capsules, cylinders) as real geometry, so the
 * camera can see it from any side, smoothly. Its parts animate with the
 * same idle loop and walk cycle, continuously; on top sits a whole-body
 * layer — breathing squash, landing squash. The sun casts its shadow.
 */
export class HerzieModel {
  /** Add this to the scene; its position is the herzie's feet — or its
   * bottom, sitting. */
  readonly root = new THREE.Group();
  /** Height of the top of the head above the feet, in world units. */
  readonly height: number;
  /** Creature-space y of the frame's centre, as world height above the feet
   * at rest: where the old renderer's camera looked. */
  readonly centerHeight: number;
  /** Encloses every part, scenery too, at any turn: centred on the axis it
   * turns about, in root space (world units, feet at the origin). */
  readonly bounds: THREE.Sphere;
  /** Which way it faces: forward is (sin, cos) on the ground (x, z). */
  heading = 0;
  readonly anim: AnimationState;
  /** Music is playing: dance (fades in and out). */
  dancing = false;
  /** On a seat: legs out in front, resting on its bottom (eased). */
  sitting = false;
  /** Aiming: its class gear in its hands, drawn off its back (see DRAW).
   * Casting draws it too, whatever this says. */
  armed = false;
  /** How many jumps it has taken off on: a host sends its parity so other
   * clients can play the same hop (see jump). */
  jumps = 0;
  /** Seconds since takeoff while airborne; undefined on the ground. */
  private airTime: number | undefined;
  /** Seconds since it landed, while it springs back; else undefined. */
  private landTime: number | undefined;
  private jumpBuffer = 0;
  /** Whether anything worn that dangles (the chain, the pearls, the witch
   * hat's tip) swings as it turns — a host can hold it still. */
  dangles = true;
  dangleConfig: DangleConfig = DEFAULT_DANGLE_CONFIG;
  /** How gear hung on threads (the discs) swings. */
  threadConfig: ThreadConfig = DEFAULT_THREAD_CONFIG;
  /** How much its cloak is simulated: "full"; "half" the substeps (far
   * off); or "frozen", carried on its drape (out of sight, a statue). The
   * Town sets it by distance. */
  clothDetail: ClothDetail = "full";
  /** How its cloak's cloth moves, instead of the cloak's own (a tuning
   * sandbox); null for the cloak's. */
  cloakConfig: CloakConfig | null = null;
  /** How far it's swung (see dangle-physics); undefined at rest. */
  private dangle: DangleState | undefined;
  private dangleSim: DangleSim | null = null;
  private readonly canDangle: boolean;
  /** The turn, unwound (so crossing ±π doesn't fling the chain), in the
   * old renderer's yAngle sense: the other way round from the heading. */
  private bodyAngle = 0;
  private lastHeading = Number.NaN;
  /** 0 not dancing to 1 dancing, eased. */
  private danceWeight = 0;
  private danceTime = 0;
  /** 0 standing to 1 seated, eased. */
  private sitWeight = 0;
  /** How far it settles when seated, in creature units (see
   * creatureSeatDrop). */
  private readonly seatDrop: number;
  /** A floating companion's dance surges (see surge.ts); null with none. */
  private readonly surge: SurgeState | null;
  private readonly surgeTuning: SurgeTuning;
  /** Seconds since it started dancing (0 when it isn't): the surges' beat. */
  private danceClock = 0;
  /** The companion's biggest part (its core), and which side of the herzie
   * it's on (+1: the herzie is toward +x), for surging it in place. */
  private readonly surgeCore: number;
  private readonly surgeToward: number;
  /** Seconds into a sonic cast; undefined when it isn't casting. */
  private castTime: number | undefined;
  /** How fast its casts play: 1, or quicker while hasted (so the motion
   * keeps up with the faster pace instead of being cut short). */
  castRate = 1;
  private castPitch = 0;
  /** The arm this cast is with, and how it moves (a disc is thrown). */
  private castArmPart: string = CAST_ARM;
  private castStyle: CastStyle = "cast";
  /** Seconds into a catch's jolt, and the arm that caught. */
  private catchTime: number | undefined;
  private catchArm: string = CAST_ARM;
  /** Each arm's part index, by part (-1 without it). */
  private readonly armAt: Record<string, number>;
  /** The meshes of each held part (class gear), by part: hidden while
   * the gear's away from the hand (a disc in flight). */
  private readonly heldMeshes: Record<string, number[]> = {};
  /** It holds class gear (held-l/held-r parts), which pose() turns with the
   * arms. */
  private readonly holdsProps: boolean;
  /** Gear hanging on threads down its back (the discs), and their swing:
   * null with none. `parts` names the held part of each weight. */
  private readonly threads: {
    rig: ThreadRig;
    sim: ThreadSim;
    parts: string[];
  } | null = null;
  /** How far each thread-hung part has swung (see heldPoses). */
  private heldSway: Record<string, [number, number, number]> | undefined;
  /** Where the torso was moved by the last pose: the threads' knot rides
   * it. */
  private torsoOffset: [number, number, number] = [0, 0, 0];
  private torsoAt = -1;
  /** Its feet in the world last frame, and how fast they were going
   * (smoothed): what accelerating it swings the threads by. */
  private lastWorld: THREE.Vector3 | null = null;
  private worldVelocity = new THREE.Vector3();
  /** Its cloak, simulated (see cloak-physics.ts); null without one. */
  private readonly cloak: CloakRun | null = null;
  /** For a herzie with no arms: the hand it grows to cast with, beside its
   * head, and where on the head it grows from. */
  private readonly popHand: {
    mesh: THREE.Mesh;
    head: Sphere;
    radius: number;
  } | null = null;
  /** How far its gear is drawn: 0 on its back to 1 in hand. */
  private drawPhase = 0;
  /** How quickly it's drawing, per second: faster when a cast won't wait. */
  private drawRate = 1 / DRAW_SECONDS;
  /** Seconds since it last wanted its gear in hand. */
  private unarmedFor = 0;
  /** The wave left the hand during the last update(). */
  released = false;
  /** Seconds the cast is still held still for (see hitstop). */
  private stopFor = 0;

  private readonly look: HerzieLook;
  private readonly model: CreatureModel;
  private readonly hasLegs: boolean;
  /** Holds the parts in creature space (y down, front −z), turned upright
   * and scaled into the world: a half turn about x, so nothing mirrors. */
  private readonly creature = new THREE.Group();
  /** The parts that stay put while it turns (see anchorScenery), in a
   * second copy of creature space; null when nothing does. */
  private readonly anchored: THREE.Group | null;
  /** Turns with the heading. */
  private readonly turn = new THREE.Group();
  /** The floating companion, flying after the herzie; null when it has none,
   * or its scenery is anchored (then the companion stays put with it). */
  private readonly follower: Follower | null;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly materials: THREE.ShaderMaterial[] = [];
  /** Creature-space y of the feet, and of the scheme's painted span. */
  private readonly feetY: number;
  private readonly span: [number, number];
  private readonly scheme: SchemeUniforms = {
    uTop: { value: 0 },
    uSpan: { value: 1 },
    uGrey: { value: 0 },
    uOpacity: { value: 1 },
    uFlash: { value: new THREE.Vector4(1, 1, 1, 0) },
  };

  constructor(look: HerzieLook, options: HerzieModelOptions = {}) {
    this.look = look;
    // The boss is built from its own params and has no legs to walk on;
    // herzies only grow legs at stage 3.
    this.hasLegs = look.stage >= 3 && !look.params;
    this.anim = newAnimationState(options.seed ?? 0);
    this.canDangle = hasDangleEquipped(look.equipped);
    this.model = buildCreatureModel(
      look.seed,
      look.stage,
      look.equipped,
      look.params,
      options.layoutCols ?? 64,
      options.layoutRows ?? 64,
    );
    const { spheres, colors, scheme, textureType } = this.model;
    const anchoring = options.anchorScenery !== undefined;
    if (!anchoring) besideHerzie(spheres);
    this.anchored = anchoring ? new THREE.Group() : null;

    let top = Number.POSITIVE_INFINITY;
    let feet = Number.NEGATIVE_INFINITY;
    for (const s of spheres) {
      // Ground props (the boombox) sit in front and reach a little below the
      // feet: they don't set where the herzie stands either. Nor does gear
      // it carries (see the renderer's buildRig).
      if (floats(s) || s.part === "ground" || s.part in HELD_ARM) continue;
      top = Math.min(top, s.center[1] - s.radius);
      feet = Math.max(feet, s.center[1] + s.radius);
    }
    this.feetY = feet;
    this.height = (feet - top) * MODEL_SCALE;
    this.centerHeight = feet * MODEL_SCALE;
    this.span = schemeSpan(spheres);
    // A cloak, on a herzie with a back to hang it from.
    const cloakStyle = look.stage >= 3 ? cloakStyleFor(look.equipped) : null;
    const cloakRig = cloakStyle ? cutCloak(cloakStyle, spheres, feet) : null;
    // Class gear rests on its back, but swings out and reaches further
    // drawn: bound it all the way through the draw.
    const drawing: Sphere[] = [];
    if (spheres.some((s) => s.held)) {
      for (let p = 0.1; p <= 1.0001; p += 0.1) {
        const d = creaturePoseOffsets(spheres, look.stage, {
          idleFrame: 0,
          walkPhase: 0,
          walkWeight: 0,
          drawPhase: p,
        });
        spheres.forEach((s, i) => {
          if (s.held || ARM_OF_HELD.has(s.part))
            drawing.push({ ...s, center: add3(s.center, d[i]) });
        });
      }
    }
    // Gear on threads can swing anywhere its threads let it: round the knot,
    // as far as they run.
    for (const s of spheres) {
      const thread = s.held?.thread;
      if (!thread) continue;
      const run = thread.rig.lengths
        .slice(0, thread.index + 1)
        .reduce((a, b) => a + b, 0);
      const across = s.shape ? Math.hypot(...s.shape.axis) : 0;
      drawing.push({
        ...s,
        shape: undefined,
        center: thread.rig.knot,
        radius: run + s.radius + across,
      });
    }
    // A cloak can swing anywhere its length lets it, round its collar.
    if (cloakRig) {
      const { rig } = cloakRig;
      const mid = (rig.cols >> 1) * 3;
      let reachOut = 0;
      for (let i = 0; i < rig.n; i++) {
        reachOut = Math.max(
          reachOut,
          Math.hypot(
            rig.rest[i * 3] - rig.rest[mid],
            rig.rest[i * 3 + 1] - rig.rest[mid + 1],
            rig.rest[i * 3 + 2] - rig.rest[mid + 2],
          ),
        );
      }
      drawing.push({
        center: [rig.rest[mid], rig.rest[mid + 1], rig.rest[mid + 2]],
        radius: reachOut,
        zone: "wearable",
        part: "cloak",
      });
    }
    this.bounds = turnBounds([...spheres, ...drawing], feet);
    this.seatDrop = this.hasLegs ? creatureSeatDrop(spheres, look.stage) : 0;
    const companionSeed = hashSeed(look.seed) ^ (options.seed ?? 0);
    this.follower = anchoring
      ? null
      : makeFollower(spheres, feet, companionSeed);
    this.surgeCore = -1;
    for (let i = 0; i < spheres.length; i++) {
      const s = spheres[i];
      if (
        floats(s) &&
        (this.surgeCore < 0 || s.radius > spheres[this.surgeCore].radius)
      )
        this.surgeCore = i;
    }
    this.surgeToward =
      this.surgeCore >= 0 && spheres[this.surgeCore].center[0] < 0 ? 1 : -1;
    this.surge =
      this.surgeCore >= 0
        ? newSurgeState(seededRandom(companionSeed ^ 0x5eed))
        : null;
    this.surgeTuning =
      look.equipped?.spirit === "ghost" ? GHOST_SURGE : SPIRIT_SURGE;
    // The companion's parts, in their own copy of creature space: upright,
    // at the herzie's scale but none of its breathing, its core at the
    // follower's origin.
    let companionParts: THREE.Group | null = null;
    if (this.follower) {
      companionParts = new THREE.Group();
      companionParts.rotation.x = Math.PI;
      companionParts.scale.setScalar(MODEL_SCALE);
      const { slot } = this.follower.host;
      companionParts.position.set(
        -slot.x,
        feet * MODEL_SCALE - slot.y,
        -slot.z,
      );
      this.follower.facing.add(companionParts);
      this.root.add(this.follower.group);
    }

    const ramp = scheme ? schemeShades(scheme) : null;
    const byShading = new Map<string, THREE.ShaderMaterial>();
    for (const s of spheres) {
      const shading = primitiveShading(s, colors, scheme);
      // Metal's grooves are laid out by its radius: one material each.
      const key = JSON.stringify(shading) + (shading.metal ? s.radius : "");
      let material = byShading.get(key);
      if (!material) {
        material = herzieMaterial(
          shading,
          textureType,
          ramp,
          this.scheme,
          options.lighting,
          s.radius,
        );
        byShading.set(key, material);
        this.materials.push(material);
      }
      const mesh = new THREE.Mesh(geometryFor(s), material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (!s.shape) mesh.scale.setScalar(s.radius);
      else {
        const axis = new THREE.Vector3(...s.shape.axis).normalize();
        mesh.quaternion.setFromUnitVectors(UP, axis);
      }
      mesh.position.set(...s.center);
      this.meshes.push(mesh);
      const parent =
        companionParts && floats(s)
          ? companionParts
          : this.anchored && sceneFixed(s)
            ? this.anchored
            : this.creature;
      parent.add(mesh);
    }
    this.armAt = {
      "arm-l": spheres.findIndex((sp) => sp.part === "arm-l"),
      "arm-r": spheres.findIndex((sp) => sp.part === "arm-r"),
    };
    spheres.forEach((sp, i) => {
      if (!(sp.part in HELD_ARM)) return;
      this.heldMeshes[sp.part] ??= [];
      this.heldMeshes[sp.part].push(i);
    });
    this.holdsProps = spheres.some((sp) => sp.part in HELD_ARM);
    const hung = spheres.filter((sp) => sp.held?.thread);
    const thread = hung[0]?.held?.thread;
    if (thread) {
      const parts: string[] = [];
      for (const sp of hung) {
        const t = sp.held?.thread;
        if (t) parts[t.index] = sp.part;
      }
      this.threads = {
        rig: thread.rig,
        sim: createThreadSim(thread.rig),
        parts,
      };
      const [cx, cy, cz] = thread.rig.center;
      this.torsoAt = spheres.findIndex(
        (sp) =>
          sp.center[0] === cx && sp.center[1] === cy && sp.center[2] === cz,
      );
    }
    if (options.armed) {
      this.armed = true;
      if (this.holdsProps) this.drawPhase = 1;
    }
    const headAt = spheres.findIndex((sp) => sp.part === "head");
    if (this.armAt[CAST_ARM] < 0 && headAt >= 0 && !look.params) {
      const head = spheres[headAt];
      const mesh = new THREE.Mesh(
        geometryFor({ ...head, shape: undefined }),
        this.meshes[headAt].material,
      );
      mesh.castShadow = true;
      mesh.visible = false;
      this.creature.add(mesh);
      this.popHand = { mesh, head, radius: head.radius * POP_HAND };
    }
    if (cloakStyle && cloakRig) {
      this.cloak = this.dressCloak(cloakStyle, cloakRig, options.lighting);
      this.creature.add(this.cloak.mesh);
      for (const clasp of this.cloak.clasps) this.creature.add(clasp);
    }
    this.creature.rotation.x = Math.PI;
    this.turn.add(this.creature);
    this.root.add(this.turn);
    if (this.anchored) {
      this.anchored.rotation.x = Math.PI;
      const facing = new THREE.Group();
      facing.rotation.y = options.anchorScenery ?? 0;
      facing.add(this.anchored);
      this.root.add(facing);
    }
    this.pose();
    this.animateBody();
    this.drawCloak();
  }

  /** Cast a sonic wave from its hand, aimed `pitch` radians above level:
   * draw, thrust, follow through. `released` turns true on the update the
   * wave leaves the hand. Casting again mid-cast starts afresh.
   *
   * `arm` casts with another arm than CAST_ARM; `style` "throw" throws
   * what's in its hand (a disc) rather than thrusting a palm, "strike"
   * strikes with it (a stick), and "bump" lunges the whole herzie into
   * what's ahead — `released` is then the moment it hits. */
  cast(
    pitch = 0,
    opts: { arm?: "arm-l" | "arm-r"; style?: CastStyle } = {},
  ): void {
    this.castTime = 0;
    this.castPitch = Math.max(-0.7, Math.min(0.7, pitch));
    this.castArmPart =
      opts.arm && this.armAt[opts.arm] >= 0 ? opts.arm : CAST_ARM;
    this.castStyle = opts.style ?? "cast";
    this.released = false;
    this.stopFor = 0;
    // Casting with its gear still on its back: it's drawn on the way, in
    // hand by the time the wave leaves.
    if (this.holdsProps && this.drawPhase < 1) {
      this.drawRate = Math.max(
        1 / DRAW_SECONDS,
        (1 - this.drawPhase) / CAST_RELEASE_SECONDS,
      );
    }
  }

  /** The blow landed: the cast holds still a moment where it hit (hit
   * stop, as fighting games do), so the eye catches the contact. */
  hitstop(seconds = HITSTOP_SECONDS): void {
    if (this.castTime !== undefined)
      this.stopFor = Math.max(this.stopFor, seconds);
  }

  /** Held still on a blow that landed (see hitstop). */
  get stopped(): boolean {
    return this.stopFor > 0;
  }

  /** How far through the cast under way it is, 0..1; undefined when it
   * isn't casting. */
  get castPhase(): number | undefined {
    return this.castTime === undefined
      ? undefined
      : this.castTime / CAST_SECONDS;
  }

  /** How the cast under way (or the last one) moves. */
  get castMotion(): CastStyle {
    return this.castStyle;
  }

  /** It has class gear to hold (so a melee blow is a strike with it,
   * not a bump). */
  get holdsGear(): boolean {
    return this.holdsProps;
  }

  /** How far its class gear is drawn: 0 on its back to 1 in hand. */
  get drawn(): number {
    return this.drawPhase;
  }

  /** It's mid-cast. */
  get casting(): boolean {
    return this.castTime !== undefined;
  }

  /** The arm the cast under way (or the last one) is with. */
  get castingArm(): string {
    return this.castArmPart;
  }

  /** It caught something (a disc) in `arm`'s hand: the arm jolts back. */
  catchPulse(arm: "arm-l" | "arm-r"): void {
    this.catchTime = 0;
    this.catchArm = arm;
  }

  /** Hides (or shows again) the class gear held in `part` ("held-l",
   * "held-r"): a disc that's been thrown isn't in the hand. */
  setHeldHidden(part: string, hidden: boolean): void {
    const at = this.heldMeshes[part];
    if (!at) return;
    for (const i of at) this.meshes[i].visible = !hidden;
  }

  /** Whether it has gear in `part` to hold. */
  holds(part: string): boolean {
    return !!this.heldMeshes[part];
  }

  /** How big the gear in `part` is: its biggest part's radius, in world
   * units (0 with none) — a disc thrown from it is drawn this size. */
  heldRadius(part: string): number {
    let r = 0;
    for (const i of this.heldMeshes[part] ?? [])
      r = Math.max(r, this.model.spheres[i].radius);
    return r * MODEL_SCALE * this.root.scale.x;
  }

  /**
   * Where the gear in `part` is, in the world: the middle of its parts
   * (posed even while hidden), or — with nothing there — the palm of its
   * arm. Call after update().
   */
  heldWorldPosition(part: string, out: THREE.Vector3): THREE.Vector3 {
    const at = this.heldMeshes[part];
    if (!at?.length) {
      const arm = HELD_ARM[part] as "arm-l" | "arm-r" | undefined;
      return this.handWorldPosition(out, arm);
    }
    out.set(0, 0, 0);
    for (const i of at) out.add(this.meshes[i].position);
    out.multiplyScalar(1 / at.length);
    this.root.updateWorldMatrix(true, true);
    const parent = this.meshes[at[0]].parent;
    return parent ? parent.localToWorld(out) : out;
  }

  /** Advances the animation and poses the parts. Call every frame. */
  update(dt: number, speed: number): void {
    stepAnimation(this.anim, dt, speed);
    this.stepDance(dt);
    if (this.surge) {
      stepSurge(
        this.surge,
        dt,
        this.danceClock,
        this.dancing,
        this.surgeTuning,
      );
    }
    this.stepSit(dt);
    this.stepJump(dt);
    this.stepDraw(dt);
    this.stepCast(dt);
    this.stepCatch(dt);
    this.swing(dt);
    this.turn.rotation.y = this.heading;
    this.pose();
    this.animateBody();
    this.drawCloak();
    this.follow(dt, speed);
  }

  /**
   * Hop: a quick ballistic arc of the body alone — the root (and whatever
   * moves it) stays on the ground, so it never stops it walking or turning.
   * Pressed in the air, it jumps again on landing if that's soon. Seated, it
   * doesn't. Returns whether it took off.
   */
  jump(): boolean {
    if (this.sitting || this.sitWeight > 0.01) return false;
    if (this.airTime !== undefined) {
      this.jumpBuffer = JUMP_BUFFER_SECONDS;
      return false;
    }
    this.airTime = 0;
    this.landTime = undefined;
    this.jumps += 1;
    return true;
  }

  /** Whether it's off the ground, mid-jump. */
  get airborne(): boolean {
    return this.airTime !== undefined;
  }

  /** How high the body is off the ground mid-jump, in world units. */
  get jumpHeight(): number {
    const t = this.airTime;
    return t === undefined
      ? 0
      : Math.max(0, JUMP_SPEED * t - 0.5 * JUMP_GRAVITY * t * t);
  }

  private stepJump(dt: number) {
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (this.airTime !== undefined) {
      this.airTime += dt;
      if (this.airTime < JUMP_AIR_SECONDS) return;
      this.airTime = undefined;
      this.landTime = 0;
      if (this.jumpBuffer > 0) {
        this.jumpBuffer = 0;
        this.jump();
      }
    } else if (this.landTime !== undefined) {
      this.landTime += dt;
      if (this.landTime >= LAND_SECONDS) this.landTime = undefined;
    }
  }

  /** Whether it has a floating companion of its own (a spirit) to send. */
  get hasCompanion(): boolean {
    return this.follower !== null;
  }

  /** Sends the companion to `point` (world space) and keeps it there until
   * called again with null, when it flies back to its herzie. */
  fetch(point: THREE.Vector3 | null): void {
    const f = this.follower;
    if (!f) return;
    if (!point) {
      f.state.target = null;
      return;
    }
    f.state.target ??= new THREE.Vector3();
    f.state.target.copy(point);
  }

  /** Where the companion is (world space, its core); null with none. */
  companionPosition(out: THREE.Vector3): THREE.Vector3 | null {
    return this.follower ? out.copy(this.follower.state.position) : null;
  }

  /** Flies the companion on after the herzie, in the world. */
  private follow(dt: number, speed: number) {
    const f = this.follower;
    if (!f) return;
    const { host, state } = f;
    // Fresh: a host may have moved it (or what it's on) this frame.
    this.root.updateWorldMatrix(true, false);
    this.root.getWorldPosition(host.position);
    host.scale = this.root.getWorldScale(scratchScale).y;
    host.heading = this.heading;
    host.dancing = this.danceWeight > 0.5;
    stepCompanion(state, host, speed, dt);
    f.group.position.copy(state.position);
    let heading = state.heading;
    let pitch = state.pitch;
    const surge = this.surge;
    if (surge) {
      // Lifted on the music, and over toward the herzie (world units).
      const unit = MODEL_SCALE * host.scale;
      const dx = host.position.x - state.position.x;
      const dz = host.position.z - state.position.z;
      const d = Math.hypot(dx, dz);
      f.group.position.y += surge.y * unit;
      if (d > 1e-6) {
        f.group.position.x += (dx / d) * surge.x * unit;
        f.group.position.z += (dz / d) * surge.x * unit;
        // Glancing at the herzie: turned toward it, never past it.
        let toward = Math.atan2(dx, dz) - heading;
        toward -= Math.round(toward / (Math.PI * 2)) * Math.PI * 2;
        heading += Math.sign(toward) * Math.min(Math.abs(toward), surge.glance);
      }
      heading += surge.spin;
      pitch -= THREE.MathUtils.clamp(
        surge.v * SURGE_TILT,
        -SURGE_MAX_TILT,
        SURGE_MAX_TILT,
      );
      const [wide, tall] = surgeStretch(surge.v);
      f.yaw.scale.set(wide, tall, wide);
    }
    this.root.worldToLocal(f.group.position);
    f.yaw.rotation.set(pitch, heading, state.roll, "YXZ");
  }

  /** Swings anything dangling with the turn since last time, and settles
   * it. update() does this; a host holding the rest of the animation still
   * (update(0, 0)) can call it on its own, so a spin still swings. */
  swing(dt: number): void {
    if (Number.isNaN(this.lastHeading)) this.lastHeading = this.heading;
    let turned = this.heading - this.lastHeading;
    turned -= Math.round(turned / (Math.PI * 2)) * Math.PI * 2;
    this.lastHeading = this.heading;
    this.bodyAngle -= turned;
    this.stepThreads(dt, turned);
    this.stepCloak(dt, turned);
    if (!this.dangles || !this.canDangle) {
      this.dangleSim = null;
      this.dangle = undefined;
      return;
    }
    // Nothing to do until it turns.
    if (!this.dangleSim && turned === 0) return;
    this.dangleSim ??= createDangleSim(this.bodyAngle - turned);
    stepDangle(this.dangleSim, this.bodyAngle, dt, this.dangleConfig);
    if (isDangleSettled(this.dangleSim, this.bodyAngle)) {
      this.dangleSim = null;
      this.dangle = undefined;
    } else {
      this.dangle = dangleState(
        this.dangleSim,
        this.bodyAngle,
        this.dangleConfig,
      );
    }
  }

  /** Swings gear hung on threads (the discs) with how it moved this frame:
   * across the world (from where its root is) and round (`turned`). */
  private stepThreads(dt: number, turned: number) {
    const threads = this.threads;
    if (!threads) return;
    this.root.updateWorldMatrix(true, false);
    const now = this.root.getWorldPosition(new THREE.Vector3());
    // How fast it's going and speeding up, smoothed over a few frames
    // (moves don't land evenly on frames) — nothing on the first, or across
    // a jump (a portal, a respawn).
    let accel = new THREE.Vector3();
    if (this.lastWorld && dt > 0) {
      const velocity = now.clone().sub(this.lastWorld).divideScalar(dt);
      if (velocity.length() > THREAD_JUMP_SPEED) {
        this.worldVelocity.set(0, 0, 0);
      } else {
        const before = this.worldVelocity.clone();
        this.worldVelocity.lerp(velocity, 1 - Math.exp(-dt / THREAD_SMOOTHING));
        accel = this.worldVelocity.clone().sub(before).divideScalar(dt);
      }
    }
    this.lastWorld = now;
    // Into creature space: unturned, upright flipped (y down, front −z),
    // and in creature units.
    const c = Math.cos(this.heading);
    const sn = Math.sin(this.heading);
    const toCreature = (v: THREE.Vector3): [number, number, number] => [
      (c * v.x - sn * v.z) / MODEL_SCALE,
      -v.y / MODEL_SCALE,
      -(sn * v.x + c * v.z) / MODEL_SCALE,
    ];
    if (dt > 0) {
      stepThreadSim(
        threads.sim,
        threads.rig,
        dt,
        {
          offset: this.torsoOffset,
          accel: toCreature(accel),
          velocity: toCreature(this.worldVelocity),
          // Turned upright, its heading's turn is the other way round its y.
          turnRate: -turned / dt,
        },
        this.threadConfig,
      );
    }
    const sway = threadSway(threads.sim, threads.rig, this.torsoOffset);
    this.heldSway = {};
    threads.parts.forEach((part, i) => {
      if (this.heldSway) this.heldSway[part] = sway[i];
    });
  }

  /** Nothing dangling is still moving. */
  get dangleSettled(): boolean {
    return (
      this.dangleSim === null &&
      (!this.threads || isThreadSettled(this.threads.sim)) &&
      (!this.cloak ||
        this.clothDetail === "frozen" ||
        isCloakSettled(this.cloak.sim))
    );
  }

  /** Whether it wears a cloak. */
  get hasCloak(): boolean {
    return this.cloak !== null;
  }

  /** Builds its cloak's cloth, mesh and brooches. */
  private dressCloak(
    style: CloakStyle,
    cut: { rig: CloakRig; parts: number[]; headAt: number; bodyAt: number },
    lighting: HerzieLighting | undefined,
  ): CloakRun {
    const { rig } = cut;
    const { spheres, colors } = this.model;
    const sim = createCloakSim(rig);
    // Where gear is slung on its back, the cloak is strapped down under it.
    for (const s of spheres) {
      if (!s.held) continue;
      const reachOf = s.radius + (s.shape ? Math.hypot(...s.shape.axis) : 0);
      for (let i = rig.cols; i < rig.n; i++) {
        const d =
          Math.hypot(
            rig.rest[i * 3] - s.center[0],
            rig.rest[i * 3 + 1] - s.center[1],
            rig.rest[i * 3 + 2] - s.center[2],
          ) - reachOf;
        const w = Math.max(0, Math.min(1, 1 - (d - 0.05) / 0.3));
        sim.strap[i] = Math.max(sim.strap[i], w);
      }
    }
    const sub = CLOAK_SMOOTHING;
    const w = (rig.cols - 1) * sub + 1;
    const h = (rig.rows - 1) * sub + 1;
    const surface = new Float32Array(w * h * 3);
    const normals = new Float32Array(w * h * 3);
    const uvs = new Float32Array(w * h * 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        uvs[(y * w + x) * 2] = x / (w - 1);
        uvs[(y * w + x) * 2 + 1] = y / (h - 1);
      }
    }
    // Two triangles a cell, wound so their front is the cloak's outside.
    const index: number[] = [];
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const a = y * w + x;
        const b = a + 1;
        const c = a + w;
        const d = c + 1;
        if (rig.outward > 0) index.push(a, b, c, b, d, c);
        else index.push(a, c, b, b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(surface, 3);
    position.setUsage(THREE.DynamicDrawUsage);
    const normal = new THREE.BufferAttribute(normals, 3);
    normal.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", position);
    geometry.setAttribute("normal", normal);
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(index);
    const shadesOf = (hex: string) =>
      primitiveShading({ zone: "wearable", color: hex }, colors).shades;
    const material = herzieMaterial(
      primitiveShading({ zone: "wearable", color: style.outer }, colors),
      0,
      null,
      this.scheme,
      lighting,
      1,
      {
        lining: shadesOf(style.lining),
        trim: shadesOf(style.trim),
        finish: CLOTH_FINISH[style.finish],
        hemTrim: style.hemTrim,
        collarTrim: style.collarTrim,
      },
    );
    this.materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // It swings out of any box worked out once: drawn whatever.
    mesh.frustumCulled = false;
    const claspMaterial = herzieMaterial(
      primitiveShading(
        { zone: "wearable", color: style.clasp, finish: "metal" },
        colors,
      ),
      0,
      null,
      this.scheme,
      lighting,
      0.07,
    );
    this.materials.push(claspMaterial);
    const clasps = [0, rig.cols - 1].map(() => {
      const m = new THREE.Mesh(UNIT_SPHERE, claspMaterial);
      m.scale.setScalar(0.075);
      m.castShadow = true;
      return m;
    });
    return {
      style,
      rig,
      sim,
      parts: cut.parts,
      headAt: cut.headAt,
      bodyAt: cut.bodyAt,
      colliders: new Float32Array(0),
      drawnColliders: new Float32Array(0),
      mesh,
      geometry,
      surface,
      scratch: new Float32Array(rig.rows * w * 3),
      normals,
      width: w,
      height: h,
      clasps,
      lastWorld: null,
      worldVelocity: new THREE.Vector3(),
    };
  }

  /** The body's colliders as it's posed now (its meshes' places). */
  private cloakCollidersNow(run: CloakRun): CloakColliders {
    run.colliders = cloakColliders(
      this.model.spheres,
      run.parts,
      run.headAt,
      run.bodyAt,
      (i) => {
        const p = this.meshes[i].position;
        return [p.x, p.y, p.z];
      },
      run.colliders,
    );
    return run.colliders;
  }

  /** Swings its cloak with how it moved this frame: across the world (from
   * where its body is — so a jump counts) and round (`turned`). */
  private stepCloak(dt: number, turned: number) {
    const run = this.cloak;
    if (!run || !(dt > 0)) return;
    this.creature.updateWorldMatrix(true, false);
    const now = this.creature.getWorldPosition(new THREE.Vector3());
    const scale = this.root.getWorldScale(scratchScale).y * MODEL_SCALE;
    let accel = new THREE.Vector3();
    let jumped = false;
    if (run.lastWorld) {
      const velocity = now.clone().sub(run.lastWorld).divideScalar(dt);
      if (velocity.length() > THREAD_JUMP_SPEED) {
        run.worldVelocity.set(0, 0, 0);
        jumped = true;
      } else {
        const before = run.worldVelocity.clone();
        run.worldVelocity.lerp(velocity, 1 - Math.exp(-dt / THREAD_SMOOTHING));
        accel = run.worldVelocity.clone().sub(before).divideScalar(dt);
      }
    }
    run.lastWorld = now;
    const offset = this.torsoOffsetOf(run);
    if (jumped) {
      // A portal, a respawn: it arrives hanging still.
      resetCloak(run.sim, run.rig, offset);
      return;
    }
    if (this.clothDetail === "frozen") {
      carryCloak(run.sim, run.rig, offset);
      return;
    }
    const c = Math.cos(this.heading);
    const sn = Math.sin(this.heading);
    const toCreature = (v: THREE.Vector3): CloakV3 => [
      (c * v.x - sn * v.z) / scale,
      -v.y / scale,
      -(sn * v.x + c * v.z) / scale,
    ];
    stepCloak(
      run.sim,
      run.rig,
      dt,
      {
        offset,
        accel: toCreature(accel),
        velocity: toCreature(run.worldVelocity),
        turnRate: -turned / dt,
        colliders: this.cloakCollidersNow(run),
        ground: this.cloakGround(),
        // Gear on its back holds the cloak down, till it's drawn.
        strap: 1 - this.drawPhase,
      },
      this.cloakConfig ?? run.style.config,
      this.clothDetail === "half" ? CLOAK_SUBSTEP * 2 : CLOAK_SUBSTEP,
    );
  }

  /** How far the pose has moved its torso from rest. */
  private torsoOffsetOf(run: CloakRun): CloakV3 {
    const p = this.meshes[run.bodyAt].position;
    const c = this.model.spheres[run.bodyAt].center;
    return [p.x - c[0], p.y - c[1], p.z - c[2]];
  }

  /** The ground under it, in creature space: nearer seated, further off
   * mid-jump. */
  private cloakGround(): number {
    const tall = this.creature.scale.y || MODEL_SCALE;
    return this.feetY - this.seatDrop * this.sitWeight + this.jumpHeight / tall;
  }

  /** Draws its cloak where its cloth is: smoothed, then pushed out of the
   * body as it's posed now, so nothing between the particles shows
   * through. */
  private drawCloak() {
    const run = this.cloak;
    if (!run) return;
    const { rig, sim } = run;
    cloakSurface(
      sim.pos,
      rig.cols,
      rig.rows,
      CLOAK_SMOOTHING,
      run.surface,
      run.scratch,
    );
    run.drawnColliders = cloakColliders(
      this.model.spheres,
      run.parts,
      run.headAt,
      run.bodyAt,
      (i) => {
        const p = this.meshes[i].position;
        return [p.x, p.y, p.z];
      },
      run.drawnColliders,
      1,
    );
    // Frozen (far off, or stone), it hangs where it settled, clear of the
    // body already: not worth the push.
    if (this.clothDetail !== "frozen") {
      pushOutOfColliders(run.surface, run.drawnColliders, CLOAK_DRAWN_MARGIN);
    }
    cloakNormals(run.surface, run.width, run.height, rig.outward, run.normals);
    const { position, normal } = run.geometry.attributes;
    position.needsUpdate = true;
    normal.needsUpdate = true;
    // The brooches, at the collar's ends.
    [0, rig.cols - 1].forEach((c, k) => {
      run.clasps[k].position.set(
        sim.pos[c * 3],
        sim.pos[c * 3 + 1],
        sim.pos[c * 3 + 2],
      );
    });
  }

  private stepDance(dt: number) {
    const target = this.dancing ? 1 : 0;
    this.danceWeight +=
      (target - this.danceWeight) * (1 - Math.exp(-DANCE_BLEND_RATE * dt));
    if (Math.abs(this.danceWeight - target) < 1e-3) this.danceWeight = target;
    if (this.danceWeight === 0) {
      this.danceTime = 0;
      this.danceClock = 0;
      return;
    }
    this.danceTime = (this.danceTime + dt) % (DANCE_LOOP_FRAMES / DANCE_FPS);
    this.danceClock += dt;
  }

  private stepDraw(dt: number) {
    if (!this.holdsProps) return;
    if (this.armed || this.castTime !== undefined) {
      this.unarmedFor = 0;
      this.drawPhase = Math.min(1, this.drawPhase + dt * this.drawRate);
      if (this.drawPhase === 1) this.drawRate = 1 / DRAW_SECONDS;
      return;
    }
    this.drawRate = 1 / DRAW_SECONDS;
    this.unarmedFor += dt;
    if (this.unarmedFor < SHEATHE_DELAY) return;
    this.drawPhase = Math.max(0, this.drawPhase - dt / SHEATHE_SECONDS);
  }

  private stepCatch(dt: number) {
    if (this.catchTime === undefined) return;
    this.catchTime += dt;
    if (this.catchTime >= CATCH_SECONDS) this.catchTime = undefined;
  }

  private stepCast(dt: number) {
    this.released = false;
    if (this.castTime === undefined) return;
    if (this.stopFor > 0) {
      // Held on the blow: what time is left over after the stop runs on.
      const held = Math.min(dt, this.stopFor);
      this.stopFor -= held;
      dt -= held;
      if (dt <= 0) return;
    }
    const before = this.castTime;
    this.castTime += dt * this.castRate;
    if (
      before < CAST_RELEASE_SECONDS &&
      this.castTime >= CAST_RELEASE_SECONDS
    ) {
      this.released = true;
    }
    if (this.castTime >= CAST_SECONDS) this.castTime = undefined;
  }

  /**
   * Where the casting hand's palm is, in the world: the front of the right
   * arm (or of the hand an armless herzie grows). Call after update() — and
   * after anything moves it — so it's this frame's.
   */
  handWorldPosition(
    out: THREE.Vector3,
    which: "arm-l" | "arm-r" = this.castArmPart as "arm-l" | "arm-r",
  ): THREE.Vector3 {
    const casting = this.castTime !== undefined && which === this.castArmPart;
    const phase = casting ? (this.castTime as number) / CAST_SECONDS : 1;
    const { dir } = castHand(
      phase,
      this.castPitch,
      which,
      casting ? this.castStyle : "cast",
    );
    const armAt =
      this.armAt[which] >= 0 ? this.armAt[which] : this.armAt[CAST_ARM];
    if (armAt >= 0) {
      const arm = this.model.spheres[armAt];
      const p = this.meshes[armAt].position;
      out.set(
        p.x + dir[0] * arm.radius,
        p.y + dir[1] * arm.radius,
        p.z + dir[2] * arm.radius,
      );
    } else if (this.popHand) {
      const { mesh, radius } = this.popHand;
      out.set(
        mesh.position.x + dir[0] * radius,
        mesh.position.y + dir[1] * radius,
        mesh.position.z + dir[2] * radius,
      );
    } else {
      // The boss: the front of its middle.
      out.set(0, this.feetY * 0.5, -1);
    }
    this.root.updateWorldMatrix(true, true);
    return this.creature.localToWorld(out);
  }

  /** The armless herzie's hand: out from the side of its head for the
   * cast, back in after. */
  private posePopHand(phase: number | undefined) {
    const pop = this.popHand;
    if (!pop) return;
    const w = phase === undefined ? 0 : castWeight(phase);
    pop.mesh.visible = w > 0.01;
    if (!pop.mesh.visible || phase === undefined) return;
    const { head, radius } = pop;
    const { dir, reach } = castHand(phase, this.castPitch);
    // The "shoulder": just inside the head's right side.
    const sx = head.center[0] - head.radius * 0.75;
    const sy = head.center[1] + head.radius * 0.15;
    const sz = head.center[2];
    const length = head.radius * 0.55 * reach;
    pop.mesh.position.set(
      sx + dir[0] * length,
      sy + dir[1] * length,
      sz + dir[2] * length,
    );
    pop.mesh.scale.setScalar(radius * w);
  }

  private stepSit(dt: number) {
    const target = this.sitting ? 1 : 0;
    this.sitWeight +=
      (target - this.sitWeight) * (1 - Math.exp(-SIT_BLEND_RATE * dt));
    if (Math.abs(this.sitWeight - target) < 1e-3) this.sitWeight = target;
  }

  /** Each part at its rest position plus the pose's offset. */
  private pose() {
    const { idleTime, walkPhase, walkWeight } = this.anim;
    const { spheres } = this.model;
    const motion: CreatureMotion = {
      idleFrame: idleTime * IDLE_FPS,
      walkPhase,
      walkWeight,
      danceFrame: this.danceTime * DANCE_FPS,
      danceWeight: this.danceWeight,
      dangle: this.dangle,
      sitWeight: this.sitWeight,
      castPhase:
        this.castTime === undefined ? undefined : this.castTime / CAST_SECONDS,
      castPitch: this.castPitch,
      castArm: this.castArmPart,
      castStyle: this.castStyle,
      catchPhase:
        this.catchTime === undefined
          ? undefined
          : this.catchTime / CATCH_SECONDS,
      catchArm: this.catchArm,
      drawPhase: this.drawPhase,
      heldSway: this.heldSway,
    };
    const offsets = creaturePoseOffsets(spheres, this.look.stage, motion);
    // A bump needs no hand.
    this.posePopHand(
      this.castTime === undefined || this.castStyle === "bump"
        ? undefined
        : this.castTime / CAST_SECONDS,
    );
    // Held props (class gear) turn as they're drawn and with their arm; a
    // solid's axis with them.
    const held = this.holdsProps
      ? heldPoses(
          spheres,
          offsets,
          this.drawPhase,
          this.heldSway,
          heldSwing(motion),
        )
      : null;
    for (let i = 0; i < spheres.length; i++) {
      const s = spheres[i];
      const [x, y, z] = s.center;
      const d = offsets[i];
      const mesh = this.meshes[i];
      mesh.position.set(x + d[0], y + d[1], z + d[2]);
      // A dangling solid (the witch hat's tip) turns with its swing, too.
      if (s.shape && s.dangle) {
        scratch.set(...dangledAxis(s, this.dangle)).normalize();
        mesh.quaternion.setFromUnitVectors(UP, scratch);
      }
      const prop = s.shape && held?.[s.part];
      if (prop && s.shape) {
        scratch.set(...prop.turn(s.shape.axis)).normalize();
        mesh.quaternion.setFromUnitVectors(UP, scratch);
      }
    }
    if (this.torsoAt >= 0) {
      const [x, y, z] = offsets[this.torsoAt];
      this.torsoOffset = [x, y, z];
    }
    if (!this.follower) this.surgeInPlace(offsets);
  }

  /**
   * A companion that doesn't fly after the herzie (its scenery anchored)
   * surges where it is: its parts lifted, drifted toward the herzie,
   * glanced and twirled about its core, and stretched with the rise — what
   * follow() does to a flying one's group, done to its parts.
   */
  private surgeInPlace(offsets: [number, number, number][]) {
    const surge = this.surge;
    if (!surge) return;
    const { spheres } = this.model;
    const core = spheres[this.surgeCore];
    const co = offsets[this.surgeCore];
    // Creature space: y is down.
    const cx = core.center[0] + co[0];
    const cy = core.center[1] + co[1];
    const cz = core.center[2] + co[2];
    const yaw = -this.surgeToward * surge.glance + surge.spin;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const [wide, tall] = surgeStretch(surge.v);
    for (let i = 0; i < spheres.length; i++) {
      const s = spheres[i];
      if (!floats(s)) continue;
      const mesh = this.meshes[i];
      const rx = mesh.position.x - cx;
      const ry = mesh.position.y - cy;
      const rz = mesh.position.z - cz;
      mesh.position.set(
        cx + (rx * cos + rz * sin) * wide + this.surgeToward * surge.x,
        cy + ry * tall - surge.y,
        cz + (-rx * sin + rz * cos) * wide,
      );
      if (!s.shape)
        mesh.scale.set(s.radius * wide, s.radius * tall, s.radius * wide);
    }
  }

  /** The whole-body layer: squash and stretch. */
  private animateBody() {
    const { idleTime, walkPhase, walkWeight: w } = this.anim;
    // A slow breath, fading out as it starts to walk or dance.
    const breath =
      Math.sin((idleTime / 3) * Math.PI * 2) *
      0.018 *
      (1 - w) *
      (1 - this.danceWeight);
    let squash = 0;
    let lift = 0;
    if (!this.hasLegs) {
      // Each hop lands with a squash, walking or dancing.
      lift = Math.abs(Math.sin(walkPhase * Math.PI * 2)) * w;
      squash = (1 - lift) ** 4 * 0.08 * w;
      const dw = this.danceWeight * (1 - w);
      if (dw > 0) {
        const hop = danceHopLift(this.danceTime * DANCE_FPS);
        squash = Math.max(squash, (1 - hop) ** 4 * 0.08 * dw);
      }
    }
    // A jump stretches it with its speed, up and down, and lands it with a
    // squash that springs back.
    if (this.airTime !== undefined) {
      const v = (JUMP_SPEED - JUMP_GRAVITY * this.airTime) / JUMP_SPEED;
      const takeoff = Math.min(1, this.airTime / TAKEOFF_SECONDS);
      squash = -AIR_STRETCH * Math.abs(v) * takeoff;
    } else if (this.landTime !== undefined) {
      const u = this.landTime / LAND_SECONDS;
      squash = Math.max(squash, LAND_SQUASH * (1 - u) ** 2);
    }
    const hop = this.jumpHeight;
    const wide = MODEL_SCALE * (1 - breath * 0.6 + squash * 0.7);
    const tall = MODEL_SCALE * (1 + breath - squash);
    this.creature.scale.set(wide, tall, wide);
    // Squash toward the feet: they stay on the ground. Seated, it settles
    // onto its bottom instead.
    this.creature.position.y =
      (this.feetY - this.seatDrop * this.sitWeight) * tall + hop;
    // What stays put doesn't breathe with the body.
    this.anchored?.scale.setScalar(MODEL_SCALE);
    this.anchored?.position.set(0, this.feetY * MODEL_SCALE, 0);

    // The scheme's bands, in world height above the feet — and scaled with
    // the herzie, if it's drawn bigger (the boss, a statue).
    const [spanTop, spanBottom] = this.span;
    const k = this.root.getWorldScale(scratchScale).y;
    this.scheme.uTop.value =
      this.root.getWorldPosition(scratch).y +
      ((this.feetY - spanTop) * tall + hop) * k;
    this.scheme.uSpan.value = Math.max(1e-6, (spanBottom - spanTop) * tall * k);
  }

  /** Grey it out (0 to 1) and make it see-through (opacity 1 to 0): a herzie
   * that isn't there yet, waiting to hatch. */
  /** Wash the whole herzie in a colour, `amount` 0 (none) to 1: a hit's
   * flash, an enrage's red. */
  setFlash(r: number, g: number, b: number, amount: number): void {
    this.scheme.uFlash.value.set(r, g, b, Math.max(0, Math.min(1, amount)));
  }

  setTint(grey: number, opacity: number): void {
    this.scheme.uGrey.value = grey;
    this.scheme.uOpacity.value = opacity;
    const transparent = opacity < 1;
    for (const m of this.materials) {
      if (m.transparent !== transparent) {
        m.transparent = transparent;
        m.needsUpdate = true;
      }
    }
  }

  /**
   * Turn it to stone: every shade greyed by how bright it was, so a statue
   * keeps the herzie's bands and markings, just carved. For good — call it
   * once, before it's drawn.
   */
  petrify(): void {
    const stone = new THREE.Color("#b6b1a7");
    for (const m of this.materials) {
      for (const name of ["uShades", "uRamp", "uLining", "uTrim"] as const) {
        if (!m.uniforms[name]) continue;
        for (const c of m.uniforms[name].value as THREE.Color[]) {
          const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
          c.copy(stone).multiplyScalar(0.4 + 0.75 * Math.sqrt(l));
        }
      }
    }
  }

  dispose() {
    for (const m of this.materials) m.dispose();
    // Its own, unlike the shared part geometries.
    this.cloak?.geometry.dispose();
  }
}
