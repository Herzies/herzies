import * as THREE from "three";

/*
 * The Sailor's Starter Pack: its pipe's smoke.
 *
 * - The ember smoulders, flickering, and a thin wisp curls up out of the
 *   bowl now and then.
 * - Every few seconds its wearer draws on the pipe: the ember glows up,
 *   brightest just as it lets go. Then it blows the smoke out by the stem —
 *   mostly a puff, round clouds that roll forward and up, swell and thin
 *   away; now and then a smoke ring, sailing off ahead of it — and the bowl
 *   sends up a plume of its own.
 * - The smoke lives in the world where it was let go, not on the herzie: a
 *   walking pipe leaves it behind. It rises, slows, leans off with a breeze
 *   and sways as it goes.
 *
 * One pooled Points object per herzie (slot 0 is the ember's glow); nothing
 * is allocated per frame. Sizes and speeds are in the herzie's own height,
 * so it looks the same at any scale.
 */

/** Smoke alive at once, at most, per herzie (and the ember's glow). */
const MAX = 64;
/** Seconds between one draw on the pipe and the next, picked between. */
const DRAW_EVERY = [4, 8] as const;
/** The first comes sooner, so a herzie's seen smoking before long. */
const FIRST_DRAW = [1.2, 3] as const;
/** How long a draw takes (the ember glowing up), and how long the puff
 * after it goes on being blown. */
const DRAW_S = 1.1;
const BLOW_S = 0.55;
/** Of the draws, how many end in a smoke ring rather than a puff. */
const RING_CHANCE = 0.3;
/** Wisps from the smouldering bowl: seconds between, picked between. */
const WISP_EVERY = [0.45, 0.9] as const;
/** The ember: how bright it smoulders, and how fast it cools after a draw
 * (per second). */
const SMOULDER = 0.35;
const COOL_RATE = 1.6;

const LIGHT = new THREE.Color("#F2EFEA");
const SHADE = new THREE.Color("#9C9791");
const EMBER = new THREE.Color("#FF7A2C");

/** A puff, a ring, or the ember's glow. */
type Kind = 0 | 1 | 2;
const PUFF: Kind = 0;
const RING: Kind = 1;
const GLOW: Kind = 2;

/** Where the smoke comes from on the model, and which way it faces. */
export interface SmokeEmitters {
  /** The ember in the bowl. */
  bowl: THREE.Object3D;
  /** The stem, at the mouth. */
  mouth: THREE.Object3D;
  /** Turns with the herzie: its +z is the way it faces. */
  facing: THREE.Object3D;
}

export class PipeSmoke {
  readonly points: THREE.Points;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly uOpacity = { value: 1 };

  // Per puff. `life` 0 is a free slot.
  private readonly pos = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly age = new Float32Array(MAX);
  private readonly life = new Float32Array(MAX);
  private readonly from = new Float32Array(MAX);
  private readonly to = new Float32Array(MAX);
  private readonly peak = new Float32Array(MAX);
  private readonly seed = new Float32Array(MAX);
  private next = 1;

  // What the shader reads.
  private readonly aSize = new Float32Array(MAX);
  private readonly aAlpha = new Float32Array(MAX);
  private readonly aKind = new Float32Array(MAX);

  private time = 0;
  /** The wall clock last step, for a paused view (dt 0). */
  private wall = 0;
  /** Seconds till the next draw, and into the one going (−1: none). */
  private untilDraw: number;
  private drawing = -1;
  /** The draw going ends in a ring. */
  private ring = false;
  private untilWisp = 0;
  /** How bright the ember is, 0..1. */
  private glow = SMOULDER;
  /** Which way the breeze takes the smoke, along the ground (unit). */
  private readonly breezeX: number;
  private readonly breezeZ: number;

  constructor(
    private readonly emitters: SmokeEmitters,
    /** The herzie's height in root units. */
    private readonly height: number,
    private readonly root: THREE.Object3D,
  ) {
    this.untilDraw = between(FIRST_DRAW);
    const a = Math.random() * Math.PI * 2;
    this.breezeX = Math.cos(a);
    this.breezeZ = Math.sin(a);

    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    for (const [name, data] of [
      ["aSize", this.aSize],
      ["aAlpha", this.aAlpha],
      ["aKind", this.aKind],
    ] as const) {
      this.geometry.setAttribute(
        name,
        new THREE.BufferAttribute(data, 1).setUsage(THREE.DynamicDrawUsage),
      );
    }
    this.geometry.setDrawRange(0, MAX);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixels: { value: 600 },
        uOpacity: this.uOpacity,
        uLight: { value: LIGHT.clone() },
        uShade: { value: SHADE.clone() },
        uEmber: { value: EMBER.clone() },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;
        attribute float aKind;
        uniform float uPixels;
        varying float vAlpha;
        varying float vKind;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          bool ortho = projectionMatrix[3][3] == 1.0;
          float px = aSize * uPixels * projectionMatrix[1][1]
            / (ortho ? 1.0 : -mv.z);
          // Too small to draw: keep a pixel, fainter, rather than flicker.
          vAlpha = aAlpha * clamp(px / 2.0, 0.0, 1.0);
          gl_PointSize = max(px, 2.0);
          vKind = aKind;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        uniform vec3 uLight;
        uniform vec3 uShade;
        uniform vec3 uEmber;
        varying float vAlpha;
        varying float vKind;
        void main() {
          float alpha = vAlpha * uOpacity;
          if (alpha <= 0.003) discard;
          // Point coords run down the sprite: up is −y.
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float d = length(p);
          vec3 col;
          float a;
          if (vKind < 0.5) {
            // A puff: a round cloud with a crisp edge, lit from above, its
            // underside in shade.
            if (d > 1.0) discard;
            a = 1.0 - smoothstep(0.84, 1.0, d);
            float lit = clamp(0.62 - p.y * 0.42 - p.x * 0.12, 0.0, 1.0);
            col = mix(uShade, uLight, lit);
          } else if (vKind < 1.5) {
            // A ring: a soft band round the middle, lit along its top.
            a = 1.0 - smoothstep(0.0, 0.2, abs(d - 0.68));
            if (a < 0.02) discard;
            col = mix(uShade, uLight, clamp(0.6 - p.y * 0.4, 0.0, 1.0));
          } else {
            // The ember's glow: hot at the heart, orange round it.
            a = exp(-d * d * 4.5);
            if (a < 0.01) discard;
            col = mix(uEmber, vec3(1.0, 0.93, 0.68), exp(-d * d * 18.0));
          }
          gl_FragColor = vec4(col, clamp(a * alpha, 0.0, 1.0));
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
    // The smoke is kept in world coordinates: whatever the herzie's parents
    // do, draw it where it is.
    this.points.matrixAutoUpdate = false;
    this.points.onBeforeRender = (renderer) => {
      this.points.matrixWorld.identity();
      // The viewport being drawn now: a pixelated pass draws into a small
      // target, and a stage of herzies into one view of the canvas each.
      renderer.getCurrentViewport(scratchViewport);
      this.material.uniforms.uPixels.value = scratchViewport.w / 2;
    };
    this.aKind[0] = GLOW;
  }

  /** Faded with the herzie (see HerzieModel.setTint). */
  setOpacity(opacity: number): void {
    this.uOpacity.value = opacity;
  }

  /** Carries the smoke of a model it replaces, so a rebuild (equipping
   * something else) doesn't blink it out or start the pipe over. */
  carryOver(from: PipeSmoke): void {
    this.pos.set(from.pos);
    this.vel.set(from.vel);
    this.age.set(from.age);
    this.life.set(from.life);
    this.from.set(from.from);
    this.to.set(from.to);
    this.peak.set(from.peak);
    this.seed.set(from.seed);
    this.aKind.set(from.aKind);
    this.next = from.next;
    this.time = from.time;
    this.untilDraw = from.untilDraw;
    this.drawing = from.drawing;
    this.ring = from.ring;
    this.untilWisp = from.untilWisp;
    this.glow = from.glow;
    this.uOpacity.value = from.uOpacity.value;
  }

  /** Steps the smoke. Call after the herzie is posed for this frame. `dt`
   * 0 (a paused view) falls back to a wall clock: the pipe goes on. */
  update(dt: number): void {
    const now = performance.now() / 1000;
    const wallDt = this.wall > 0 ? Math.min(now - this.wall, 0.1) : 0;
    this.wall = now;
    if (dt <= 0) dt = wallDt;
    if (dt <= 0) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.root.updateWorldMatrix(true, true);
    const unit = this.height * this.root.getWorldScale(scratchScale).y;
    if (unit <= 0) return;
    const bowl = this.emitters.bowl.getWorldPosition(scratchBowl);

    // A draw on the pipe: the ember glows up, eased in, then it's let go
    // and blown out over BLOW_S.
    if (this.drawing < 0) {
      this.untilDraw -= dt;
      if (this.untilDraw <= 0) {
        this.drawing = 0;
        this.ring = Math.random() < RING_CHANCE;
      }
      this.glow += (SMOULDER - this.glow) * (1 - Math.exp(-COOL_RATE * dt));
    } else {
      const before = this.drawing;
      this.drawing += dt;
      if (this.drawing < DRAW_S) {
        const t = this.drawing / DRAW_S;
        this.glow = Math.max(this.glow, SMOULDER + (1 - SMOULDER) * t * t);
      } else {
        this.glow += (SMOULDER - this.glow) * (1 - Math.exp(-COOL_RATE * dt));
        if (before < DRAW_S) this.letGo(bowl, unit);
        // The puff's rolled out over a moment, a cloud at a time.
        if (!this.ring) {
          const k0 = Math.floor(((before - DRAW_S) / BLOW_S) * 5);
          const k1 = Math.floor(((this.drawing - DRAW_S) / BLOW_S) * 5);
          for (let k = Math.max(k0, 0) + 1; k <= Math.min(k1, 5); k++)
            this.blowPuff(unit, k / 5);
        }
        if (this.drawing >= DRAW_S + BLOW_S) {
          this.drawing = -1;
          this.untilDraw = between(DRAW_EVERY);
        }
      }
    }

    // A thin wisp from the smouldering bowl, now and then.
    this.untilWisp -= dt;
    if (this.untilWisp <= 0) {
      this.untilWisp = between(WISP_EVERY);
      this.wisp(bowl, unit, 0.3);
    }

    // The ember's glow, flickering, on the bowl.
    const flicker =
      0.85 +
      0.1 * Math.sin(this.time * 13.1) +
      0.05 * Math.sin(this.time * 29.7 + 1.3);
    this.pos[0] = bowl.x;
    this.pos[1] = bowl.y + unit * 0.012;
    this.pos[2] = bowl.z;
    this.aSize[0] = unit * (0.05 + 0.06 * this.glow);
    this.aAlpha[0] = Math.min(1, this.glow * flicker);

    this.step(dt, unit);
  }

  /** The draw's done: what it blows out, and the bowl's plume. */
  private letGo(bowl: THREE.Vector3, unit: number) {
    if (this.ring) this.blowRing(unit);
    else this.blowPuff(unit, 0);
    for (let k = 0; k < 3; k++) this.wisp(bowl, unit, 0.55);
  }

  /** The way the herzie faces, along the ground (unit), into scratchFwd. */
  private forward(): THREE.Vector3 {
    const f = this.emitters.facing.getWorldDirection(scratchFwd);
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(0, 0, 1);
    return f.normalize();
  }

  /** One cloud of a puff blown out by the stem, `k` (0..1) through it:
   * the later ones weaker. */
  private blowPuff(unit: number, k: number) {
    const f = this.forward();
    const at = this.emitters.mouth.getWorldPosition(scratchAt);
    at.addScaledVector(f, unit * 0.03);
    const speed = unit * (0.42 - 0.2 * k) * (0.85 + Math.random() * 0.3);
    const side = (Math.random() - 0.5) * unit * 0.12;
    this.spawn(
      at,
      f.x * speed - f.z * side,
      unit * (0.1 + Math.random() * 0.06),
      f.z * speed + f.x * side,
      2.2 + Math.random() * 0.8,
      unit * 0.045,
      unit * (0.2 + Math.random() * 0.06) * (1 - 0.3 * k),
      0.78 - 0.25 * k,
      PUFF,
    );
  }

  /** A smoke ring, sailing off ahead. */
  private blowRing(unit: number) {
    const f = this.forward();
    const at = this.emitters.mouth.getWorldPosition(scratchAt);
    at.addScaledVector(f, unit * 0.04);
    const speed = unit * 0.38;
    this.spawn(
      at,
      f.x * speed,
      unit * 0.05,
      f.z * speed,
      2.6,
      unit * 0.07,
      unit * 0.3,
      0.85,
      RING,
    );
  }

  /** A wisp up out of the bowl: `strength` how thick it is. */
  private wisp(bowl: THREE.Vector3, unit: number, strength: number) {
    scratchAt.set(
      bowl.x + (Math.random() - 0.5) * unit * 0.01,
      bowl.y + unit * 0.02,
      bowl.z + (Math.random() - 0.5) * unit * 0.01,
    );
    this.spawn(
      scratchAt,
      (Math.random() - 0.5) * unit * 0.03,
      unit * (0.13 + Math.random() * 0.05),
      (Math.random() - 0.5) * unit * 0.03,
      1.8 + Math.random() * 0.8,
      unit * 0.018,
      unit * (0.07 + 0.08 * strength),
      strength,
      PUFF,
    );
  }

  private spawn(
    at: THREE.Vector3,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    from: number,
    to: number,
    peak: number,
    kind: Kind,
  ) {
    // Round the pool past the glow's slot: the oldest goes first when full.
    const i = this.next;
    this.next = this.next + 1 >= MAX ? 1 : this.next + 1;
    this.pos[i * 3] = at.x;
    this.pos[i * 3 + 1] = at.y;
    this.pos[i * 3 + 2] = at.z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.from[i] = from;
    this.to[i] = to;
    this.peak[i] = peak;
    this.aKind[i] = kind;
    this.seed[i] = Math.random() * 100;
  }

  private step(dt: number, unit: number) {
    // Slowed by the air; lifted, warm, a little; and taken by the breeze.
    const drag = Math.exp(-1.4 * dt);
    const lift = unit * 0.05 * dt;
    const breeze = unit * 0.06;
    for (let i = 1; i < MAX; i++) {
      if (this.life[i] <= 0) {
        this.aAlpha[i] = 0;
        this.aSize[i] = 0;
        continue;
      }
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) {
        this.life[i] = 0;
        this.aAlpha[i] = 0;
        this.aSize[i] = 0;
        continue;
      }
      const j = i * 3;
      // The older, the more the breeze has it.
      const take = 1 - Math.exp(-0.9 * dt * t);
      this.vel[j] =
        this.vel[j] * drag + (this.breezeX * breeze - this.vel[j]) * take;
      this.vel[j + 1] = this.vel[j + 1] * drag + lift;
      this.vel[j + 2] =
        this.vel[j + 2] * drag +
        (this.breezeZ * breeze - this.vel[j + 2]) * take;
      // A slow sway, growing as it rises: smoke curls.
      const sway =
        Math.sin(this.time * 1.9 + this.seed[i]) * unit * 0.05 * t * dt;
      this.pos[j] += this.vel[j] * dt + sway;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt - sway * 0.6;

      // Swells fast, then slowly; in quickly, thinning away.
      const grow = 1 - (1 - t) ** 3;
      const fadeIn = Math.min(1, t / 0.08);
      this.aSize[i] = this.from[i] + (this.to[i] - this.from[i]) * grow;
      this.aAlpha[i] = this.peak[i] * fadeIn * (1 - t) ** 1.6;
    }
    // Always drawn: the ember glows whatever the smoke's doing.
    const g = this.geometry.attributes;
    g.position.needsUpdate = true;
    g.aSize.needsUpdate = true;
    g.aAlpha.needsUpdate = true;
    g.aKind.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** A number picked between `range`'s two. */
function between(range: readonly [number, number]): number {
  return range[0] + Math.random() * (range[1] - range[0]);
}

const scratchViewport = new THREE.Vector4();
const scratchScale = new THREE.Vector3();
const scratchBowl = new THREE.Vector3();
const scratchAt = new THREE.Vector3();
const scratchFwd = new THREE.Vector3();
