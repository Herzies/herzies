import * as THREE from "three";

/*
 * Eivind's Evasive Pair: the sparkle its wings shed.
 *
 * - Moving, the wing tips leave a trail of small sky-blue sparkles. They're
 *   emitted by distance travelled, not by time (Unity's rate over distance),
 *   spaced evenly along the way the tip went, so a sprint leaves no gaps and
 *   standing still leaves nothing. They live in the world, where they were
 *   dropped, not on the herzie, so they read as a trail.
 * - Each sparkle pops in fast, then shrinks and fades away, eased: white-hot
 *   at first, cooling to blue. It drifts up a little, like down shaken off a
 *   wing, and slows in the air. A few are four-pointed glints rather than
 *   soft dots, and every one twinkles.
 * - Each time a foot comes down, a small ring of sparkles puffs out along the
 *   ground.
 * - Standing still, now and then one faint twinkle near a wing.
 *
 * One pooled Points object per herzie; nothing is allocated per frame.
 * Sizes and speeds are in the herzie's own height, so it looks the same at
 * any scale.
 */

/** Sparkles alive at once, at most, per herzie. */
const MAX = 120;
/** How far the herzie goes between one wing sparkle and the next, in
 * heights. */
const TRAIL_SPACING = 0.16;
/** A jump in one frame further than this (heights) is a teleport: no trail
 * across it. */
const TELEPORT = 3;
/** Standing still: twinkles a second, for both feet together. */
const IDLE_RATE = 0.9;
/** A foot is up once it's this far off its resting height (heights), and
 * down again under the second. */
const FOOT_UP = 0.03;
const FOOT_DOWN = 0.01;
/** Sparkles in a footfall's ring. */
const PUFF = 7;

const COOL = new THREE.Color("#4F9BFF");
const HOT = new THREE.Color("#F2FAFF");

type Kind = 0 | 1;

/** The model parts it emits from, and how. */
export interface SparkleEmitters {
  /** Wing tips: the trail, and the idle twinkles. */
  wings: THREE.Object3D[];
  /** One per foot: footfalls. */
  feet: THREE.Object3D[];
}

export class ShoeSparkles {
  readonly points: THREE.Points;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;

  // Per sparkle. `life` 0 is a free slot.
  private readonly pos = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly age = new Float32Array(MAX);
  private readonly life = new Float32Array(MAX);
  private readonly size = new Float32Array(MAX);
  private readonly drag = new Float32Array(MAX);
  private readonly rise = new Float32Array(MAX);
  private readonly seed = new Float32Array(MAX);
  private readonly kindOf = new Uint8Array(MAX);
  private next = 0;

  // What the shader reads.
  private readonly aSize = new Float32Array(MAX);
  private readonly aAlpha = new Float32Array(MAX);
  private readonly aHeat = new Float32Array(MAX);
  private readonly aKind = new Float32Array(MAX);

  private readonly lastWing: THREE.Vector3[];
  private readonly footRest: number[];
  private readonly footUp: boolean[];
  private readonly lastRoot = new THREE.Vector3();
  private started = false;
  /** Distance gone since the last trail sparkle, in heights. */
  private owed = 0;
  private time = 0;
  private wingTurn = 0;

  constructor(
    private readonly root: THREE.Object3D,
    private readonly emitters: SparkleEmitters,
    /** The herzie's height in root units. */
    private readonly height: number,
  ) {
    this.lastWing = emitters.wings.map(() => new THREE.Vector3());
    this.footRest = emitters.feet.map(() => Number.POSITIVE_INFINITY);
    this.footUp = emitters.feet.map(() => false);

    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    for (const [name, data] of [
      ["aSize", this.aSize],
      ["aAlpha", this.aAlpha],
      ["aHeat", this.aHeat],
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
        uCool: { value: COOL.clone() },
        uHot: { value: HOT.clone() },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;
        attribute float aHeat;
        attribute float aKind;
        uniform float uPixels;
        varying float vAlpha;
        varying float vHeat;
        varying float vKind;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          bool ortho = projectionMatrix[3][3] == 1.0;
          float px = aSize * uPixels * projectionMatrix[1][1]
            / (ortho ? 1.0 : -mv.z);
          // Too small to draw: keep a pixel, dimmer, rather than flicker out.
          vAlpha = aAlpha * clamp(px / 2.0, 0.0, 1.0);
          gl_PointSize = max(px, 2.0);
          vHeat = aHeat;
          vKind = aKind;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uCool;
        uniform vec3 uHot;
        varying float vAlpha;
        varying float vHeat;
        varying float vKind;
        void main() {
          if (vAlpha <= 0.003) discard;
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float d2 = dot(p, p);
          // A soft dot with a bright core…
          float glow = exp(-d2 * 5.0);
          float core = exp(-d2 * 28.0);
          // …or a glint: two thin crossed rays.
          float rays = exp(-abs(p.x) * 18.0) * (1.0 - abs(p.y))
            + exp(-abs(p.y) * 18.0) * (1.0 - abs(p.x));
          float shape = vKind > 0.5
            ? max(rays * 0.9, core * 1.2)
            : glow * 0.9 + core * 0.6;
          if (shape < 0.01) discard;
          vec3 col = mix(uCool, uHot, clamp(vHeat * 0.8 + core * 0.6, 0.0, 1.0));
          // Alpha-blended, not added: added light washes out on a sunny
          // path, and these must read on anything.
          gl_FragColor = vec4(col, clamp(shape * vAlpha, 0.0, 1.0));
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
    // The sparkles are kept in world coordinates: whatever the herzie's
    // parents do, draw them where they are.
    this.points.matrixAutoUpdate = false;
    this.points.onBeforeRender = (renderer) => {
      this.points.matrixWorld.identity();
      // The viewport being drawn now: a pixelated pass draws into a small
      // target, and a stage of herzies into one view of the canvas each.
      renderer.getCurrentViewport(scratchViewport);
      this.material.uniforms.uPixels.value = scratchViewport.w / 2;
    };
  }

  /** Steps the sparkles. Call after the herzie is posed for this frame. */
  update(dt: number): void {
    if (dt <= 0) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.root.updateWorldMatrix(true, true);
    const unit = this.height * this.root.getWorldScale(scratchScale).y;
    if (unit <= 0) return;
    const root = this.root.getWorldPosition(scratchRoot);

    // How far it went this frame, along the ground.
    const moved = this.started
      ? Math.hypot(root.x - this.lastRoot.x, root.z - this.lastRoot.z) / unit
      : 0;
    const teleported = moved > TELEPORT;
    this.lastRoot.copy(root);

    // The trail: one sparkle per TRAIL_SPACING gone, taking turns between
    // the wing tips, each placed along the way that tip went this frame.
    const wings = this.emitters.wings;
    if (!teleported && this.started && wings.length > 0) {
      this.owed += moved;
      const due = Math.floor(this.owed / TRAIL_SPACING);
      this.owed -= due * TRAIL_SPACING;
      for (let n = 0; n < Math.min(due, 12); n++) {
        const w = this.wingTurn++ % wings.length;
        const now = wings[w].getWorldPosition(scratchA);
        const t = due > 1 ? (n + 1) / due : Math.random();
        scratchB.copy(this.lastWing[w]).lerp(now, t);
        this.emitTrail(scratchB, unit);
      }
    } else {
      this.owed = 0;
    }

    // Standing still: an occasional faint twinkle by a wing.
    if (moved / dt < 0.2 && wings.length > 0) {
      if (Math.random() < IDLE_RATE * dt) {
        const w = wings[Math.floor(Math.random() * wings.length)];
        this.emitIdle(w.getWorldPosition(scratchA), unit);
      }
    }
    for (let i = 0; i < wings.length; i++) {
      wings[i].getWorldPosition(this.lastWing[i]);
    }

    // Footfalls: a foot that was up has come down.
    const feet = this.emitters.feet;
    for (let i = 0; i < feet.length; i++) {
      const at = feet[i].getWorldPosition(scratchA);
      const h = (at.y - root.y) / unit;
      if (!this.started || h < this.footRest[i]) this.footRest[i] = h;
      const lift = h - this.footRest[i];
      if (!this.footUp[i] && lift > FOOT_UP) this.footUp[i] = true;
      else if (this.footUp[i] && lift < FOOT_DOWN) {
        this.footUp[i] = false;
        if (!teleported) this.puff(at, root.y, unit);
      }
    }
    this.started = true;

    this.step(dt, unit);
  }

  private spawn(
    at: THREE.Vector3,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size: number,
    kind: Kind,
    drag: number,
    rise: number,
  ) {
    // Round the pool: the oldest goes first when it's full.
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.pos[i * 3] = at.x;
    this.pos[i * 3 + 1] = at.y;
    this.pos[i * 3 + 2] = at.z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
    this.kindOf[i] = kind;
    this.drag[i] = drag;
    this.rise[i] = rise;
    this.seed[i] = Math.random() * 100;
  }

  private emitTrail(at: THREE.Vector3, unit: number) {
    const s = unit * 0.35;
    const glint = Math.random() < 0.22;
    this.spawn(
      at,
      (Math.random() - 0.5) * s,
      (0.25 + Math.random() * 0.35) * s,
      (Math.random() - 0.5) * s,
      0.45 + Math.random() * 0.4,
      unit * (glint ? 0.13 : 0.08) * (0.7 + Math.random() * 0.6),
      glint ? 1 : 0,
      3.5,
      0.25 * unit,
    );
  }

  private emitIdle(at: THREE.Vector3, unit: number) {
    scratchC.set(
      at.x + (Math.random() - 0.5) * unit * 0.08,
      at.y + Math.random() * unit * 0.05,
      at.z + (Math.random() - 0.5) * unit * 0.08,
    );
    this.spawn(
      scratchC,
      0,
      0.08 * unit,
      0,
      0.7 + Math.random() * 0.3,
      unit * 0.11,
      1,
      2,
      0.05 * unit,
    );
  }

  private puff(at: THREE.Vector3, groundY: number, unit: number) {
    const turn = Math.random() * Math.PI * 2;
    for (let k = 0; k < PUFF; k++) {
      const a = turn + (k / PUFF) * Math.PI * 2;
      const speed = unit * (0.9 + Math.random() * 0.4);
      scratchC.set(at.x, groundY + unit * 0.02, at.z);
      this.spawn(
        scratchC,
        Math.cos(a) * speed,
        unit * 0.15,
        Math.sin(a) * speed,
        0.28 + Math.random() * 0.1,
        unit * 0.06,
        0,
        7,
        0,
      );
    }
  }

  private step(dt: number, unit: number) {
    let alive = 0;
    for (let i = 0; i < MAX; i++) {
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
      alive++;
      // Slowed by the air, and lifted a little, like down.
      const k = Math.exp(-this.drag[i] * dt);
      const j = i * 3;
      this.vel[j] *= k;
      this.vel[j + 1] = this.vel[j + 1] * k + this.rise[i] * dt;
      this.vel[j + 2] *= k;
      // A slow sideways sway.
      const sway = Math.sin(this.time * 6 + this.seed[i]) * unit * 0.04 * dt;
      this.pos[j] += this.vel[j] * dt + sway;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt - sway;

      // Pops in over the first tenth, then shrinks away, eased out.
      const pop = 1 - (1 - Math.min(1, t / 0.1)) ** 3;
      const shrink = 1 - t * t;
      const twinkle =
        0.75 + 0.25 * Math.sin(this.time * 22 + this.seed[i] * 7.3);
      this.aSize[i] = this.size[i] * pop * shrink;
      this.aAlpha[i] = pop * (1 - t) ** 1.5 * twinkle;
      this.aHeat[i] = 1 - Math.min(1, t * 1.8);
      this.aKind[i] = this.kindOf[i];
    }
    this.points.visible = alive > 0;
    const g = this.geometry.attributes;
    g.position.needsUpdate = true;
    g.aSize.needsUpdate = true;
    g.aAlpha.needsUpdate = true;
    g.aHeat.needsUpdate = true;
    g.aKind.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

const scratchViewport = new THREE.Vector4();
const scratchScale = new THREE.Vector3();
const scratchRoot = new THREE.Vector3();
const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();
const scratchC = new THREE.Vector3();
