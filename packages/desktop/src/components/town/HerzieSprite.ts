import { type FrameData, renderCreaturePose } from "@herzies/shared";
import { LRUCache } from "lru-cache";
import * as THREE from "three";
import type { Look } from "../TownScene";
import {
  type AnimationState,
  newAnimationState,
  quantizePose,
  stepAnimation,
} from "./animation";

/** The render grid each herzie is drawn from: a third finer than the
 * renderer's default 48 x 48, framed the same — still chunky pixels, but
 * enough of them for a face to read at a distance. */
const COLS = 64;
const ROWS = 64;
/** A renderer cell is a character cell — 0.6 wide to 1.35 tall — and the
 * renderer's projection is built for that shape, so the sprite keeps it. */
const CELL_ASPECT = 0.6 / 1.35;
/** World height of the whole render grid (all 48 rows), and its width. */
const GRID_H = 4.5;
const GRID_W = (GRID_H * COLS * CELL_ASPECT) / ROWS;
/** Frames kept per herzie. A frame is ~2300 cells, so this bounds memory;
 * the working set (one camera angle, one loop) is far smaller. */
const CACHE_FRAMES = 64;

/**
 * New frames cost ~1-2ms each (renderCreaturePose: 0.9ms measured at
 * 48 x 48, and cost grows with the cell count), so
 * each rendered frame may spend this much drawing new ones across all
 * herzies; the rest wait a frame, still showing their last pose. Keeps a
 * crowd from hitching the frame rate when the camera swings round.
 */
const FRAME_BUDGET_MS = 4;
let budgetLeft = FRAME_BUDGET_MS;
/** Called once at the start of every rendered frame. */
export function resetFrameBudget() {
  budgetLeft = FRAME_BUDGET_MS;
}

type Cells = FrameData["cells"];

const scratch = new THREE.Vector3();

/**
 * A herzie standing in the 3D Town: its ASCII render as a camera-facing
 * sprite, redrawn from whichever side and height the camera sees it, mid
 * breath or mid stride. On top of the drawn frames (which step at the
 * renderer's resolution) sits a continuous layer — breathing squash,
 * landing squash, a blob shadow — so the motion reads as smooth.
 */
export class HerzieSprite {
  /** Add this to the scene; its position is the herzie's feet. */
  readonly root = new THREE.Group();
  /** Height of the top of the head above the feet, in world units. */
  readonly height: number;
  /** Which way it faces: forward is (sin, cos) on the ground (x, z). */
  heading = 0;
  readonly anim: AnimationState;

  private readonly look: Look;
  private readonly hasLegs: boolean;
  private readonly breathesWhileWalking: boolean;
  private readonly sprite: THREE.Sprite;
  private readonly shadow: THREE.Mesh;
  private readonly canvas = document.createElement("canvas");
  private readonly texture: THREE.CanvasTexture;
  private readonly cache = new LRUCache<string, Cells>({ max: CACHE_FRAMES });
  private shownKey = "";

  constructor(look: Look, seed = 0) {
    this.look = look;
    // The boss is built from its own params and has no legs to walk on;
    // herzies only grow legs at stage 3.
    this.hasLegs = look.stage >= 3 && !look.params;
    this.breathesWhileWalking = !!look.equipped?.spirit;
    this.anim = newAnimationState(seed);

    // One texel per cell: drawn as solid blocks, not glyphs, and scaled up
    // with nearest filtering, so the herzie is solid but stays pixel-chunky.
    this.canvas.width = COLS;
    this.canvas.height = ROWS;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.texture, alphaTest: 0.5 }),
    );
    this.sprite.scale.set(GRID_W, GRID_H, 1);

    // Stand it on its feet: the sprite's anchor goes on the lowest drawn
    // row of the resting pose, so scaling squashes toward the ground.
    const rest = this.render(quantizePose(this.restPose()).pose);
    let top = -1;
    let feet = -1;
    rest.forEach((row, y) => {
      if (!row.some((c) => c.ch !== " ")) return;
      if (top < 0) top = y;
      feet = y;
    });
    this.sprite.center.set(0.5, 1 - (feet + 1) / rest.length);
    this.height = ((feet - top + 1) / rest.length) * GRID_H;

    // A soft dark disc on the ground: what makes a sprite stand somewhere.
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 24),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.02;
    this.shadow.scale.set(this.height * 0.36, this.height * 0.22, 1);
    this.shadow.renderOrder = -1;

    this.root.add(this.shadow, this.sprite);
  }

  /** Advances the animation and redraws for `camera`. Call every frame. */
  update(dt: number, speed: number, camera: THREE.Camera): void {
    stepAnimation(this.anim, dt, speed);
    const at = this.root.getWorldPosition(scratch);
    const cam = camera.position;
    const dx = cam.x - at.x;
    const dz = cam.z - at.z;
    // Seen from: the camera's bearing relative to where the herzie faces,
    // and how far above its middle the camera sits.
    const yAngle = Math.atan2(dx, dz) - this.heading;
    const pitch = Math.atan2(
      cam.y - (at.y + this.height / 2),
      Math.hypot(dx, dz),
    );
    const { key, pose } = quantizePose({
      yAngle,
      pitch,
      anim: this.anim,
      breathesWhileWalking: this.breathesWhileWalking,
    });
    if (key !== this.shownKey) {
      let cells = this.cache.get(key);
      // Over budget: keep showing the last pose this frame, unless there is
      // none yet.
      if (!cells && (budgetLeft > 0 || !this.shownKey)) {
        const t0 = performance.now();
        cells = this.render(pose);
        budgetLeft -= performance.now() - t0;
        this.cache.set(key, cells);
      }
      if (cells) {
        this.draw(cells);
        this.shownKey = key;
      }
    }
    this.animateBody();
  }

  /** The continuous layer: squash and stretch, and the shadow. */
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
    this.sprite.scale.set(
      GRID_W * (1 - breath * 0.6 + squash * 0.7),
      GRID_H * (1 + breath - squash),
      1,
    );
    const s = 1 - lift * 0.3;
    this.shadow.scale.set(this.height * 0.36 * s, this.height * 0.22 * s, 1);
  }

  private restPose() {
    return {
      yAngle: 0,
      pitch: 0,
      anim: newAnimationState(),
      breathesWhileWalking: false,
    };
  }

  private render(pose: ReturnType<typeof quantizePose>["pose"]): Cells {
    return renderCreaturePose(
      this.look.seed,
      this.look.stage,
      pose,
      this.look.equipped,
      this.look.params,
      COLS,
      ROWS,
    ).cells;
  }

  /** Each cell as one solid texel in its colour. The renderer draws every
   * cell with the same block glyph and puts all its shading in the colour,
   * so nothing is lost — but where glyphs left gaps between rows (and their
   * own dither), blocks don't. */
  private draw(cells: Cells) {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, COLS, ROWS);
    for (let y = 0; y < cells.length; y++) {
      const row = cells[y];
      for (let x = 0; x < row.length; x++) {
        const cell = row[x];
        if (cell.ch === " ") continue;
        ctx.fillStyle = cell.color;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
    this.sprite.material.dispose();
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.Material).dispose();
    this.cache.clear();
  }
}
