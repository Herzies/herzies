import * as THREE from "three";
import {
  buildCreatureModel,
  CREATURE_FRAME_HEIGHT,
  type CreatureModel,
  type CreatureParams,
  creaturePoseOffsets,
  creatureSeatDrop,
  DANCE_LOOP_FRAMES,
  danceHopLift,
  dangledAxis,
  hasDangleEquipped,
  primitiveShading,
  SPIRIT_DANCE_HOP_VARIANT_COUNT,
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
  type AnimationState,
  IDLE_FPS,
  newAnimationState,
  stepAnimation,
} from "./animation.js";
import {
  type CompanionHost,
  type CompanionState,
  newCompanionState,
  stepCompanion,
} from "./companion.js";
import {
  type HerzieLighting,
  herzieMaterial,
  type SchemeUniforms,
} from "./herzieMaterial.js";

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
};

/** The old renderer's dance loop: 65ms a frame. */
const DANCE_FPS = 1000 / 65;
/** Chance a dance loop with a Greedy Spirit plays without a hop: roughly
 * one hop every 4s, as before. */
const SPIRIT_CALM_LOOP_CHANCE = 0.6;
/** How quickly dancing fades in and out, per second. */
const DANCE_BLEND_RATE = 6;
/** How quickly it sits down and stands up (per second). */
const SIT_BLEND_RATE = 14;
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
  /** Whether anything worn that dangles (the chain, the pearls, the witch
   * hat's tip) swings as it turns — a host can hold it still. */
  dangles = true;
  dangleConfig: DangleConfig = DEFAULT_DANGLE_CONFIG;
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
  private hopVariant: number | undefined;

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
      // feet: they don't set where the herzie stands either.
      if (floats(s) || s.part === "ground") continue;
      top = Math.min(top, s.center[1] - s.radius);
      feet = Math.max(feet, s.center[1] + s.radius);
    }
    this.feetY = feet;
    this.height = (feet - top) * MODEL_SCALE;
    this.centerHeight = feet * MODEL_SCALE;
    this.span = schemeSpan(spheres);
    this.bounds = turnBounds(spheres, feet);
    this.seatDrop = this.hasLegs ? creatureSeatDrop(spheres, look.stage) : 0;
    this.follower = anchoring
      ? null
      : makeFollower(spheres, feet, hashSeed(look.seed) ^ (options.seed ?? 0));
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
      const key = JSON.stringify(shading);
      let material = byShading.get(key);
      if (!material) {
        material = herzieMaterial(
          shading,
          textureType,
          ramp,
          this.scheme,
          options.lighting,
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
  }

  /** Advances the animation and poses the parts. Call every frame. */
  update(dt: number, speed: number): void {
    stepAnimation(this.anim, dt, speed);
    this.stepDance(dt);
    this.stepSit(dt);
    this.swing(dt);
    this.turn.rotation.y = this.heading;
    this.pose();
    this.animateBody();
    this.follow(dt, speed);
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
    this.root.worldToLocal(f.group.position);
    f.yaw.rotation.set(state.pitch, state.heading, state.roll, "YXZ");
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

  /** Nothing dangling is still moving. */
  get dangleSettled(): boolean {
    return this.dangleSim === null;
  }

  private stepDance(dt: number) {
    const target = this.dancing ? 1 : 0;
    this.danceWeight +=
      (target - this.danceWeight) * (1 - Math.exp(-DANCE_BLEND_RATE * dt));
    if (Math.abs(this.danceWeight - target) < 1e-3) this.danceWeight = target;
    if (this.danceWeight === 0) {
      this.danceTime = 0;
      return;
    }
    const before = this.danceTime * DANCE_FPS;
    this.danceTime += dt;
    const loop = DANCE_LOOP_FRAMES / DANCE_FPS;
    if (this.danceTime >= loop) {
      this.danceTime %= loop;
      this.rerollHop();
    } else if (before === 0) this.rerollHop();
  }

  private stepSit(dt: number) {
    const target = this.sitting ? 1 : 0;
    this.sitWeight +=
      (target - this.sitWeight) * (1 - Math.exp(-SIT_BLEND_RATE * dt));
    if (Math.abs(this.sitWeight - target) < 1e-3) this.sitWeight = target;
  }

  /** The Greedy Spirit picks its hop afresh each loop: none, or a variant
   * other than the last, so hops land irregularly. */
  private rerollHop() {
    if (Math.random() < SPIRIT_CALM_LOOP_CHANCE) {
      this.hopVariant = undefined;
      return;
    }
    let next = Math.floor(Math.random() * SPIRIT_DANCE_HOP_VARIANT_COUNT);
    if (next === this.hopVariant)
      next = (next + 1) % SPIRIT_DANCE_HOP_VARIANT_COUNT;
    this.hopVariant = next;
  }

  /** Each part at its rest position plus the pose's offset. */
  private pose() {
    const { idleTime, walkPhase, walkWeight } = this.anim;
    const { spheres } = this.model;
    const offsets = creaturePoseOffsets(spheres, this.look.stage, {
      idleFrame: idleTime * IDLE_FPS,
      walkPhase,
      walkWeight,
      danceFrame: this.danceTime * DANCE_FPS,
      danceWeight: this.danceWeight,
      spiritHopVariant: this.hopVariant,
      dangle: this.dangle,
      sitWeight: this.sitWeight,
    });
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
    const wide = MODEL_SCALE * (1 - breath * 0.6 + squash * 0.7);
    const tall = MODEL_SCALE * (1 + breath - squash);
    this.creature.scale.set(wide, tall, wide);
    // Squash toward the feet: they stay on the ground. Seated, it settles
    // onto its bottom instead.
    this.creature.position.y =
      (this.feetY - this.seatDrop * this.sitWeight) * tall;
    // What stays put doesn't breathe with the body.
    this.anchored?.scale.setScalar(MODEL_SCALE);
    this.anchored?.position.set(0, this.feetY * MODEL_SCALE, 0);

    // The scheme's bands, in world height above the feet — and scaled with
    // the herzie, if it's drawn bigger (the boss, a statue).
    const [spanTop, spanBottom] = this.span;
    const k = this.root.getWorldScale(scratchScale).y;
    this.scheme.uTop.value =
      this.root.getWorldPosition(scratch).y + (this.feetY - spanTop) * tall * k;
    this.scheme.uSpan.value = Math.max(1e-6, (spanBottom - spanTop) * tall * k);
  }

  /** Grey it out (0 to 1) and make it see-through (opacity 1 to 0): a herzie
   * that isn't there yet, waiting to hatch. */
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
      for (const name of ["uShades", "uRamp"] as const) {
        for (const c of m.uniforms[name].value as THREE.Color[]) {
          const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
          c.copy(stone).multiplyScalar(0.4 + 0.75 * Math.sqrt(l));
        }
      }
    }
  }

  dispose() {
    for (const m of this.materials) m.dispose();
  }
}
