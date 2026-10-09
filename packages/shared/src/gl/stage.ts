import * as THREE from "three";

/** Something drawn on the stage: a scene seen through a camera, inside an
 * element's box on the page. */
export type StageView = {
  element: HTMLElement;
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** Called once a frame before drawing, with the time since the last frame
   * (seconds) and the element's size in CSS px. */
  update(dt: number, width: number, height: number): void;
};

/** The longest frame step animations are allowed to take: coming back to a
 * hidden page shouldn't fast-forward everything. */
const MAX_DT = 0.1;
/** How often (in frames) to look again for the elements that clip a view. */
const CLIP_REFRESH_FRAMES = 60;

type Entry = { view: StageView; clips: HTMLElement[]; clipAge: number };

/**
 * One WebGL canvas for every herzie on the page.
 *
 * Browsers allow only a handful of WebGL contexts (about 16), and a page
 * full of herzies (the website's landing page) has more than that. So there
 * is one transparent canvas, fixed over the whole window and ignoring the
 * pointer, and each view is drawn into its own element's box with a scissor:
 * the three.js "multiple elements" pattern. Views follow their elements as
 * the page scrolls, and are clipped to any scrolling or overflow-hidden box
 * they're inside, as the element itself would be.
 *
 * Drawn at a fraction of the screen's resolution (`pixelScale`) and scaled
 * up without smoothing: the chunky pixels herzies have everywhere.
 */
class HerzieStage {
  /** Drawn pixels per CSS pixel. */
  pixelScale = 1 / 3;
  private renderer: THREE.WebGLRenderer | null = null;
  private entries = new Set<Entry>();
  private raf = 0;
  private last = 0;
  private frameCount = 0;

  /** The stage's canvas, once there is one (to style it: a host greying the
   * whole app, say). */
  get canvas(): HTMLCanvasElement | null {
    return this.renderer?.domElement ?? null;
  }

  private filter = "";

  /** A CSS filter over every herzie on the stage (a host greying out its
   * whole UI: the canvas isn't inside it). */
  setFilter(filter: string) {
    this.filter = filter;
    if (this.renderer) this.renderer.domElement.style.filter = filter;
  }

  /** Draw `view` from now on; returns the function that stops it. */
  add(view: StageView): () => void {
    const entry: Entry = { view, clips: [], clipAge: CLIP_REFRESH_FRAMES };
    this.entries.add(entry);
    this.start();
    return () => {
      this.entries.delete(entry);
      if (this.entries.size === 0) this.stop();
    };
  }

  private ensureRenderer(): THREE.WebGLRenderer {
    if (this.renderer) return this.renderer;
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
    renderer.setClearColor(0x000000, 0);
    renderer.setScissorTest(true);
    const c = renderer.domElement;
    c.setAttribute("aria-hidden", "true");
    Object.assign(c.style, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      pointerEvents: "none",
      // Above the page's own backdrops (a sky) like the herzie it replaces,
      // but under anything else stacked up (overlays come later in the
      // page, so they paint over it at the same level).
      zIndex: "1",
      imageRendering: "pixelated",
      filter: this.filter,
    });
    document.body.prepend(c);
    this.renderer = renderer;
    return renderer;
  }

  private start() {
    if (this.raf) return;
    this.last = performance.now();
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      this.frame(Math.min(MAX_DT, (now - this.last) / 1000));
      this.last = now;
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.renderer) {
      // Nothing to draw: leave the canvas empty rather than frozen.
      this.renderer.setScissorTest(false);
      this.renderer.clear();
      this.renderer.setScissorTest(true);
    }
  }

  private frame(dt: number) {
    const renderer = this.ensureRenderer();
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (renderer.getPixelRatio() !== this.pixelScale)
      renderer.setPixelRatio(this.pixelScale);
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x !== width || size.y !== height)
      renderer.setSize(width, height, false);
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    this.frameCount++;

    for (const entry of this.entries) {
      const { view } = entry;
      const el = view.element;
      // Not laid out (display: none somewhere up the tree): nothing to draw.
      if (!el.isConnected || el.getClientRects().length === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      if (++entry.clipAge >= CLIP_REFRESH_FRAMES) {
        entry.clipAge = 0;
        entry.clips = clippingAncestors(el);
      }
      let left = Math.max(0, rect.left);
      let top = Math.max(0, rect.top);
      let right = Math.min(width, rect.right);
      let bottom = Math.min(height, rect.bottom);
      for (const clip of entry.clips) {
        const c = clip.getBoundingClientRect();
        left = Math.max(left, c.left);
        top = Math.max(top, c.top);
        right = Math.min(right, c.right);
        bottom = Math.min(bottom, c.bottom);
      }
      if (right <= left || bottom <= top) continue;

      view.update(dt, rect.width, rect.height);
      // GL's origin is the bottom left.
      renderer.setViewport(
        rect.left,
        height - rect.bottom,
        rect.width,
        rect.height,
      );
      renderer.setScissor(left, height - bottom, right - left, bottom - top);
      renderer.render(view.scene, view.camera);
    }
  }
}

/** The boxes that cut off an element's overflow, nearest first. */
function clippingAncestors(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (
    let p = el.parentElement;
    p && p !== document.body;
    p = p.parentElement
  ) {
    const s = getComputedStyle(p);
    if (s.overflowX !== "visible" || s.overflowY !== "visible") out.push(p);
  }
  return out;
}

/** The page's one stage. */
export const herzieStage = new HerzieStage();
