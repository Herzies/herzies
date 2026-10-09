import {
  buildCreatureModel,
  CREATURE_FRAME_HEIGHT,
  type CreatureModel,
  creaturePoseOffsets,
  primitiveShading,
  type Sphere,
  schemeShades,
  schemeSpan,
} from "@herzies/shared";
import * as THREE from "three";
import type { Look } from "../TownScene";
import {
  type AnimationState,
  IDLE_FPS,
  newAnimationState,
  stepAnimation,
} from "./animation";
import { herzieMaterial, type SchemeUniforms } from "./herzieMaterial";

/** The grid a herzie used to be drawn on in the Town. Props placed at the
 * frame's edge (a floating pet) are placed against it, so they keep their
 * spot. */
const LAYOUT_COLS = 64;
const LAYOUT_ROWS = 64;
/** World units per creature unit: the renderer's whole frame (at the
 * herzie's centre) is 4.5 world units tall, the size the sprites were. */
export const MODEL_SCALE = 4.5 / CREATURE_FRAME_HEIGHT;

/** Parts anchored beside the herzie rather than on it (see the renderer's
 * isSceneFixed): they don't count toward where it stands or how tall it is. */
const floats = (s: Sphere) => s.part === "spirit" || s.part === "pet";

/** Air between a floating companion and the herzie, in creature units. */
const COMPANION_GAP = 0.15;

// Geometries are shared between herzies, cached by size, and kept for the
// app's lifetime: there are only a handful of distinct ones.
const UNIT_SPHERE = new THREE.SphereGeometry(1, 20, 14);
const geometries = new Map<string, THREE.BufferGeometry>();
const UP = new THREE.Vector3(0, 1, 0);
const scratch = new THREE.Vector3();
const scratchScale = new THREE.Vector3();

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
 * layer — breathing squash, landing squash, a blob shadow.
 */
export class HerzieModel {
  /** Add this to the scene; its position is the herzie's feet. */
  readonly root = new THREE.Group();
  /** Height of the top of the head above the feet, in world units. */
  readonly height: number;
  /** Which way it faces: forward is (sin, cos) on the ground (x, z). */
  heading = 0;
  readonly anim: AnimationState;

  private readonly look: Look;
  private readonly model: CreatureModel;
  private readonly hasLegs: boolean;
  /** Holds the parts in creature space (y down, front −z), turned upright
   * and scaled into the world: a half turn about x, so nothing mirrors. */
  private readonly creature = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly shadow: THREE.Mesh;
  /** Creature-space y of the feet, and of the scheme's painted span. */
  private readonly feetY: number;
  private readonly span: [number, number];
  private readonly scheme: SchemeUniforms = {
    uTop: { value: 0 },
    uSpan: { value: 1 },
  };

  constructor(look: Look, seed = 0) {
    this.look = look;
    // The boss is built from its own params and has no legs to walk on;
    // herzies only grow legs at stage 3.
    this.hasLegs = look.stage >= 3 && !look.params;
    this.anim = newAnimationState(seed);
    this.model = buildCreatureModel(
      look.seed,
      look.stage,
      look.equipped,
      look.params,
      LAYOUT_COLS,
      LAYOUT_ROWS,
    );
    const { spheres, colors, scheme, textureType } = this.model;
    besideHerzie(spheres);

    let top = Number.POSITIVE_INFINITY;
    let feet = Number.NEGATIVE_INFINITY;
    for (const s of spheres) {
      if (floats(s)) continue;
      top = Math.min(top, s.center[1] - s.radius);
      feet = Math.max(feet, s.center[1] + s.radius);
    }
    this.feetY = feet;
    this.height = (feet - top) * MODEL_SCALE;
    this.span = schemeSpan(spheres);

    const ramp = scheme ? schemeShades(scheme) : null;
    const byShading = new Map<string, THREE.ShaderMaterial>();
    for (const s of spheres) {
      const shading = primitiveShading(s, colors, scheme);
      const key = JSON.stringify(shading);
      let material = byShading.get(key);
      if (!material) {
        material = herzieMaterial(shading, textureType, ramp, this.scheme);
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
      this.creature.add(mesh);
    }
    this.creature.rotation.x = Math.PI;

    // A faint dark disc right under it: the sun casts the real shadow, but
    // when it's high that is barely wider than the feet.
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 24),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
      }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.02;
    this.shadow.renderOrder = -1;

    this.root.add(this.shadow, this.creature);
    this.pose();
    this.animateBody();
  }

  /** Advances the animation and poses the parts. Call every frame. */
  update(dt: number, speed: number): void {
    stepAnimation(this.anim, dt, speed);
    this.root.rotation.y = this.heading;
    this.pose();
    this.animateBody();
  }

  /** Each part at its rest position plus the pose's offset. */
  private pose() {
    const { idleTime, walkPhase, walkWeight } = this.anim;
    const { spheres } = this.model;
    const offsets = creaturePoseOffsets(spheres, this.look.stage, {
      idleFrame: idleTime * IDLE_FPS,
      walkPhase,
      walkWeight,
    });
    for (let i = 0; i < spheres.length; i++) {
      const [x, y, z] = spheres[i].center;
      const d = offsets[i];
      this.meshes[i].position.set(x + d[0], y + d[1], z + d[2]);
    }
  }

  /** The whole-body layer: squash and stretch, and the shadow. */
  private animateBody() {
    const { idleTime, walkPhase, walkWeight: w } = this.anim;
    // A slow breath, fading out as it starts to walk.
    const breath = Math.sin((idleTime / 3) * Math.PI * 2) * 0.018 * (1 - w);
    let squash = 0;
    let lift = 0;
    if (!this.hasLegs) {
      // Each hop lands with a squash; the shadow shrinks while airborne.
      lift = Math.abs(Math.sin(walkPhase * Math.PI * 2)) * w;
      squash = (1 - lift) ** 4 * 0.08 * w;
    }
    const wide = MODEL_SCALE * (1 - breath * 0.6 + squash * 0.7);
    const tall = MODEL_SCALE * (1 + breath - squash);
    this.creature.scale.set(wide, tall, wide);
    // Squash toward the feet: they stay on the ground.
    this.creature.position.y = this.feetY * tall;

    // The scheme's bands, in world height above the feet — and scaled with
    // the herzie, if it's drawn bigger (the boss, a statue).
    const [spanTop, spanBottom] = this.span;
    const k = this.root.getWorldScale(scratchScale).y;
    this.scheme.uTop.value =
      this.root.getWorldPosition(scratch).y + (this.feetY - spanTop) * tall * k;
    this.scheme.uSpan.value = Math.max(1e-6, (spanBottom - spanTop) * tall * k);

    const s = 1 - lift * 0.3;
    this.shadow.scale.set(this.height * 0.36 * s, this.height * 0.22 * s, 1);
  }

  /**
   * Turn it to stone: every shade greyed by how bright it was, so a statue
   * keeps the herzie's bands and markings, just carved. For good — call it
   * once, before it's drawn.
   */
  petrify(): void {
    // Carved onto its plinth: no blob shadow (wider than the plinth's top,
    // it'd hang in the air past its edges).
    this.shadow.visible = false;
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
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.Material).dispose();
  }
}
