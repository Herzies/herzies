import * as THREE from "three";
import { GLASS_ORDER } from "./herzieMaterial.js";

/*
 * A full set's shimmer (ItemSet.shimmer): sparkles shed from the herzie's
 * body in the set's two colours, or bubbles rising round it (`style`).
 * Made to sit in the background: noticed by whoever's looking, never in
 * the way.
 *
 * Same family as the Evasive Pair's sparkles (shoeSparkles.ts):
 * - Emitted on a shell round the body, and then they live in the world, not
 *   on the herzie. Each is born carrying a share of the herzie's own
 *   velocity, then slowed by the air, so a moving herzie leaves a glittering
 *   wake behind it and a still one has a gentle halo that drifts up.
 * - Fade in and out smoothly and twinkle with a sine, never on/off, so
 *   nothing pops (a bubble's pop at the top is the one exception). Sizes
 *   are in the herzie's height; a sparkle that would be under two pixels
 *   stays two pixels and dims instead of flickering out.
 * - Drawn after the glass body, so the skin and the set's solid parts never
 *   hide it.
 * - Runs on a wall clock when the herzie is paused, so previews still glitter.
 *
 * One pooled Points object per herzie; nothing is allocated per frame.
 */

/** Particles alive at once, at most. */
const MAX = 80;
/** A jump in one frame further than this (heights) is a teleport. */
const TELEPORT = 3;
/** Draw order: after the glass skin and the solid set parts. */
const ORDER = GLASS_ORDER + 1;

/** How a style's particles are born and move. */
interface Motion {
  /** A second standing still. */
  idleRate: number;
  /** Extra a second per height/second of speed. */
  speedRate: number;
  /** The share of the herzie's velocity a new one starts with. */
  inherit: number;
  /** Air drag: higher trails off sooner. */
  drag: number;
  /** Upward pull, heights/second². */
  lift: number;
  /** Born between these heights (share of the herzie's). */
  from: number;
  to: number;
  /** Seconds alive: `life` plus up to `lifeJitter`. */
  life: number;
  lifeJitter: number;
  /** Size, in heights, before jitter. */
  size: number;
}

const SPARKLE: Motion = {
  idleRate: 14,
  speedRate: 18,
  inherit: 0.55,
  drag: 1.8,
  lift: 0.12,
  from: 0.08,
  to: 0.98,
  life: 1.3,
  lifeJitter: 1.1,
  size: 0.045,
};

/** Bubbles (the Streetsmart set's milk froth): fewer and bigger, born low
 * and wobbling slowly up past the crown, where they pop. */
const BUBBLE: Motion = {
  idleRate: 2.2,
  speedRate: 3,
  inherit: 0.4,
  drag: 1.2,
  lift: 0.22,
  from: 0.1,
  to: 0.5,
  life: 3.2,
  lifeJitter: 1.6,
  size: 0.085,
};

export interface ShimmerColors {
  /** Most sparkles (white, for FF). */
  core: string;
  /** The rest of the sparkles (pink, for FF). */
  edge: string;
  /** Sparkles (the default) or bubbles: a ring with a glint, popping at
   * the top. */
  style?: "sparkle" | "bubble";
}

export class SetShimmer {
  /** Add to the herzie's root (its feet). */
  readonly group = new THREE.Group();
  private readonly points: THREE.Points;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly uOpacity = { value: 1 };
  private readonly bubbles: boolean;
  private readonly motion: Motion;

  private readonly pos = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly age = new Float32Array(MAX);
  private readonly life = new Float32Array(MAX);
  private readonly size = new Float32Array(MAX);
  private readonly seed = new Float32Array(MAX);
  private readonly kindOf = new Float32Array(MAX);
  private readonly aSize = new Float32Array(MAX);
  private readonly aAlpha = new Float32Array(MAX);
  private readonly aTint = new Float32Array(MAX);
  private readonly aKind = new Float32Array(MAX);
  private next = 0;

  private readonly lastRoot = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private started = false;
  private time = 0;
  private owed = 0;
  private wall = 0;
  private root: THREE.Object3D | null = null;

  /** `height` and `width`: the herzie's, in root units. */
  constructor(
    colors: ShimmerColors,
    private readonly height: number,
    private readonly width: number,
  ) {
    this.bubbles = colors.style === "bubble";
    this.motion = this.bubbles ? BUBBLE : SPARKLE;
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    for (const [name, data] of [
      ["aSize", this.aSize],
      ["aAlpha", this.aAlpha],
      ["aTint", this.aTint],
      ["aKind", this.aKind],
    ] as const) {
      this.geometry.setAttribute(
        name,
        new THREE.BufferAttribute(data, 1).setUsage(THREE.DynamicDrawUsage),
      );
    }
    this.geometry.setDrawRange(0, MAX);

    this.material = new THREE.ShaderMaterial({
      defines: this.bubbles ? { BUBBLE: "" } : {},
      uniforms: {
        uPixels: { value: 600 },
        uOpacity: this.uOpacity,
        uCore: { value: new THREE.Color(colors.core) },
        uEdge: { value: new THREE.Color(colors.edge) },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;
        attribute float aTint;
        attribute float aKind;
        uniform float uPixels;
        varying float vAlpha;
        varying float vTint;
        varying float vKind;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          bool ortho = projectionMatrix[3][3] == 1.0;
          float px = aSize * uPixels * projectionMatrix[1][1]
            / (ortho ? 1.0 : -mv.z);
          #ifdef BUBBLE
          // A ring needs a few pixels to read as one: never smaller than
          // four, whole pixels so its edge stays crisp.
          vAlpha = aAlpha * clamp(px / 4.0, 0.0, 1.0);
          gl_PointSize = floor(max(px, 4.0) + 0.5);
          #else
          // Too small to draw: keep two pixels, dimmer, rather than flicker.
          vAlpha = aAlpha * clamp(px / 2.0, 0.0, 1.0);
          gl_PointSize = max(px, 2.0);
          #endif
          vTint = aTint;
          vKind = aKind;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uCore;
        uniform vec3 uEdge;
        uniform float uOpacity;
        varying float vAlpha;
        varying float vTint;
        varying float vKind;
        void main() {
          if (vAlpha <= 0.003) discard;
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          #ifdef BUBBLE
          // A crisp ring, a glint up on one side, the faintest fill.
          float d = length(p);
          if (d > 1.0) discard;
          float ring = step(0.68, d);
          float glint = step(length(p - vec2(-0.34, -0.34)), 0.24);
          vec3 rim = mix(uCore, uEdge, vTint);
          vec3 col = glint > 0.5 ? vec3(1.0) : ring > 0.5 ? rim : uCore;
          float a = ring * 0.8 + glint * 0.95 + 0.04;
          gl_FragColor = vec4(col, clamp(a * vAlpha * uOpacity, 0.0, 1.0));
          #else
          float d2 = dot(p, p);
          float glow = exp(-d2 * 5.0);
          float core = exp(-d2 * 28.0);
          float rays = exp(-abs(p.x) * 18.0) * (1.0 - abs(p.y))
            + exp(-abs(p.y) * 18.0) * (1.0 - abs(p.x));
          float shape = vKind > 0.5
            ? max(rays * 0.9, core * 1.2)
            : glow * 0.8 + core * 0.6;
          if (shape < 0.01) discard;
          vec3 body = mix(mix(uCore, vec3(1.0), 0.4), uEdge, vTint);
          vec3 col = mix(body, vec3(1.0), clamp(core * 0.7, 0.0, 1.0));
          gl_FragColor = vec4(col, clamp(shape * vAlpha * uOpacity, 0.0, 1.0));
          #endif
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = ORDER;
    // Kept in world coordinates: draw them where they are.
    this.points.matrixAutoUpdate = false;
    this.points.onBeforeRender = (renderer) => {
      this.points.matrixWorld.identity();
      renderer.getCurrentViewport(scratchViewport);
      this.material.uniforms.uPixels.value = scratchViewport.w / 2;
    };
    this.group.add(this.points);
  }

  /** True while any sparkle is alive: a stage must keep drawing. */
  get active(): boolean {
    return this.points.visible;
  }

  /** Carries the clock-free state of a model it replaces, so a rebuild
   * (equipping something) doesn't blink the sparkles out. Sparkles don't
   * carry over into bubbles, or back. */
  carryOver(from: SetShimmer): void {
    if (from.bubbles === this.bubbles) {
      this.pos.set(from.pos);
      this.vel.set(from.vel);
      this.age.set(from.age);
      this.life.set(from.life);
      this.size.set(from.size);
      this.seed.set(from.seed);
      this.kindOf.set(from.kindOf);
      this.aTint.set(from.aTint);
      this.next = from.next;
    }
    this.time = from.time;
    this.uOpacity.value = from.uOpacity.value;
    this.lastRoot.copy(from.lastRoot);
    this.velocity.copy(from.velocity);
    this.started = from.started;
  }

  /** Steps the sparkles. `dt` 0 (paused) falls back to a wall clock. */
  update(dt: number): void {
    const now = performance.now() / 1000;
    const wallDt = this.wall > 0 ? Math.min(now - this.wall, 0.1) : 0;
    this.wall = now;
    if (dt <= 0) dt = wallDt;
    if (dt <= 0) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;

    const root = this.root ?? this.group.parent;
    if (!root) return;
    this.root = root;
    root.updateWorldMatrix(true, false);
    const unit = this.height * root.getWorldScale(scratchScale).y;
    if (unit <= 0) return;
    const at = scratchRoot.setFromMatrixPosition(root.matrixWorld);

    // The herzie's velocity in heights a second, smoothed a little.
    if (this.started) {
      scratchA.copy(at).sub(this.lastRoot);
      if (scratchA.length() / unit > TELEPORT) this.velocity.set(0, 0, 0);
      else {
        scratchA.multiplyScalar(1 / (unit * dt));
        this.velocity.lerp(scratchA, 1 - Math.exp(-dt * 14));
      }
    }
    this.lastRoot.copy(at);
    this.started = true;

    // Emit: a steady halo, more when it's moving.
    const speed = this.velocity.length();
    const m = this.motion;
    this.owed += (m.idleRate + m.speedRate * Math.min(speed, 4)) * dt;
    let n = Math.min(Math.floor(this.owed), 6);
    this.owed -= Math.floor(this.owed);
    while (n-- > 0) this.emit(root, unit);

    this.step(dt, unit);
  }

  private emit(root: THREE.Object3D, unit: number) {
    const m = this.motion;
    // A point on a shell round the body, between the style's heights.
    const a = Math.random() * Math.PI * 2;
    const h = m.from + Math.random() * (m.to - m.from);
    const bulge = Math.sin(Math.PI * Math.min(1, h * 1.05)) * 0.5 + 0.35;
    const r = (this.width / 2) * bulge * (1.05 + Math.random() * 0.4);
    scratchB.set(Math.cos(a) * r, h * this.height, Math.sin(a) * r);
    scratchB.applyMatrix4(root.matrixWorld);

    // Born sharing the herzie's motion, with a lazy swirl and a lift.
    const swirl = unit * (this.bubbles ? 0.04 : 0.12);
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    const j = i * 3;
    this.pos[j] = scratchB.x;
    this.pos[j + 1] = scratchB.y;
    this.pos[j + 2] = scratchB.z;
    this.vel[j] =
      this.velocity.x * unit * m.inherit -
      Math.sin(a) * swirl +
      (Math.random() - 0.5) * unit * 0.05;
    this.vel[j + 1] =
      this.velocity.y * unit * m.inherit + unit * (0.1 + Math.random() * 0.18);
    this.vel[j + 2] =
      this.velocity.z * unit * m.inherit +
      Math.cos(a) * swirl +
      (Math.random() - 0.5) * unit * 0.05;
    const glint = !this.bubbles && Math.random() < 0.2;
    this.age[i] = 0;
    this.life[i] = m.life + Math.random() * m.lifeJitter;
    this.size[i] =
      unit * m.size * (glint ? 1.55 : 1) * (0.7 + Math.random() * 0.6);
    this.kindOf[i] = glint ? 1 : 0;
    this.aTint[i] = Math.random() < (this.bubbles ? 0.45 : 0.4) ? 1 : 0;
    this.seed[i] = Math.random() * 100;
  }

  private step(dt: number, unit: number) {
    let alive = 0;
    const m = this.motion;
    const k = Math.exp(-m.drag * dt);
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
      const j = i * 3;
      this.vel[j] *= k;
      this.vel[j + 1] = this.vel[j + 1] * k + unit * m.lift * dt;
      this.vel[j + 2] *= k;
      const sway =
        Math.sin(this.time * (this.bubbles ? 2 : 3) + this.seed[i]) *
        unit *
        (this.bubbles ? 0.05 : 0.03) *
        dt;
      this.pos[j] += this.vel[j] * dt + sway;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt - sway;

      if (this.bubbles) {
        // In over the first tenth; at the top a quick swell, then it pops.
        const inn = Math.min(1, t / 0.1);
        const swell = Math.max(0, (t - 0.9) / 0.1);
        this.aSize[i] = this.size[i] * (0.6 + 0.4 * inn) * (1 + 0.25 * swell);
        this.aAlpha[i] = inn * inn * (3 - 2 * inn);
      } else {
        // Smooth in over the first fifth, out over the rest; a soft twinkle.
        const inn = Math.min(1, t / 0.2);
        const fadeIn = inn * inn * (3 - 2 * inn);
        const out = 1 - t;
        const twinkle =
          0.7 + 0.3 * Math.sin(this.time * 9 + this.seed[i] * 7.3);
        this.aSize[i] = this.size[i] * fadeIn * (1 - 0.5 * t * t);
        this.aAlpha[i] = fadeIn * out * out * twinkle;
      }
      this.aKind[i] = this.kindOf[i];
    }
    this.points.visible = alive > 0;
    const g = this.geometry.attributes;
    g.position.needsUpdate = true;
    g.aSize.needsUpdate = true;
    g.aAlpha.needsUpdate = true;
    g.aTint.needsUpdate = true;
    g.aKind.needsUpdate = true;
  }

  /** Fades with the herzie (setTint's opacity). */
  setOpacity(opacity: number): void {
    this.uOpacity.value = opacity;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

const scratchViewport = new THREE.Vector4();
const scratchScale = new THREE.Vector3();
const scratchRoot = new THREE.Vector3();
const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();
