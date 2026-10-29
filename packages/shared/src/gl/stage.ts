import * as THREE from "three";

/** Something drawn on the stage: a scene seen through a camera, inside an
 * element's box on the page. */
export type StageView = {
  element: HTMLElement;
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** Called once a frame before drawing, with the time since the last frame
   * (seconds), the element's size in CSS px, and how opaque the page draws
   * it (its own and its ancestors' opacity, multiplied). */
  update(dt: number, width: number, height: number, alpha: number): void;
  /** Nothing about it is moving (paused, settled): if every view is idle
   * and none moved on the page, the stage skips drawing the frame. */
  idle(): boolean;
};

/** The longest frame step animations are allowed to take: coming back to a
 * hidden page shouldn't fast-forward everything. */
const MAX_DT = 0.1;
/** How often (in frames) to look again for the elements that clip a view. */
const CLIP_REFRESH_FRAMES = 60;
/** Scrolling with the page (see setHost), the canvas reaches this share of
 * the screen beyond its top and bottom edges, so what scrolls into view
 * before the next frame is already drawn. */
const SCROLL_MARGIN = 0.5;

type Entry = { view: StageView; clips: HTMLElement[]; clipAge: number };

/**
 * One WebGL canvas for every herzie on the page.
 *
 * Browsers allow only a handful of WebGL contexts (about 16), and a page
 * full of herzies (the website's landing page) has more than that. So there
 * is one transparent canvas, fixed over the whole window and ignoring the
 * pointer, and each view is drawn into its own element's box with a scissor:
 * the three.js "multiple elements" pattern. A view follows its element as
 * the page scrolls or animates it, is clipped to any scrolling or
 * overflow-hidden box it's inside, and fades with its ancestors' opacity,
 * as the element itself would.
 *
 * Drawn at a fraction of the screen's resolution (`pixelScale`) and scaled
 * up without smoothing: the chunky pixels herzies have everywhere.
 */
export class HerzieStage {
  /** Drawn pixels per CSS pixel. */
  pixelScale = 1 / 4;
  private renderer: THREE.WebGLRenderer | null = null;
  private host: HTMLElement | null = null;
  /** The canvas scrolls with the page, inside `host` (see setHost). */
  private scrolls = false;
  private entries = new Set<Entry>();
  private raf = 0;
  private last = 0;
  /** Where everything was last drawn, to tell whether anything moved. */
  private lastLayout = "";

  /**
   * Put the canvas inside `host` (first, under the rest of it) instead of
   * straight in the page's body, or back in the body with null. An app that
   * stacks overlays or applies filters on its own root passes that root:
   * the herzies then sit inside its stacking order, under its overlays, and
   * take its filters.
   */
  setHost(host: HTMLElement | null, { scrolls = false } = {}) {
    this.host = host;
    this.scrolls = !!host && scrolls;
    const c = this.renderer?.domElement;
    if (c) {
      this.place(c);
      (host ?? document.body).prepend(c);
    }
    this.lastLayout = "";
  }

  /**
   * Fixed over the window; or, with `scrolls` (a page that scrolls the
   * window, its host a positioned box that clips, covering the page), in
   * the host, moved over the screen each frame. Fixed, a phone's scrolling
   * (which runs ahead of the page's script) leaves the herzies a frame
   * behind the page; in the page, they move with it.
   */
  private place(c: HTMLCanvasElement) {
    Object.assign(
      c.style,
      this.scrolls
        ? { position: "absolute", inset: "auto", left: "0", top: "0" }
        : {
            position: "fixed",
            inset: "0",
            width: "100vw",
            height: "100vh",
            transform: "",
          },
    );
  }

  /** Draw `view` from now on; returns the function that stops it. */
  add(view: StageView): () => void {
    const entry: Entry = { view, clips: [], clipAge: CLIP_REFRESH_FRAMES };
    this.entries.add(entry);
    this.lastLayout = "";
    this.start();
    return () => {
      this.entries.delete(entry);
      this.lastLayout = "";
      if (this.entries.size === 0) this.stop();
    };
  }

  private ensureRenderer(): THREE.WebGLRenderer {
    if (this.renderer) return this.renderer;
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
    renderer.setClearColor(0x000000, 0);
    renderer.setScissorTest(true);
    // A view's own sun can cast shadows (see HerzieView), as in the Town.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const c = renderer.domElement;
    c.setAttribute("aria-hidden", "true");
    this.place(c);
    Object.assign(c.style, {
      pointerEvents: "none",
      // Above the page's own backdrops (a sky), like the herzie canvases it
      // replaces, but under anything stacked up after it.
      zIndex: "1",
      imageRendering: "pixelated",
    });
    (this.host ?? document.body).prepend(c);
    this.renderer = renderer;
    return renderer;
  }

  /** Done with it for good (a stage of its own, not the page's): its
   * canvas comes off the page and its WebGL context is freed. */
  dispose() {
    this.entries.clear();
    this.stop();
    if (this.renderer) {
      this.renderer.domElement.remove();
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer = null;
    }
  }

  private start() {
    if (this.raf) return;
    if (this.renderer) {
      // Shown again (see stop), empty until the first frame draws.
      this.renderer.setScissorTest(false);
      this.renderer.clear();
      this.renderer.setScissorTest(true);
      this.renderer.domElement.style.visibility = "";
    }
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
      // Nothing to draw: leave the canvas empty rather than frozen. Hidden
      // as well: a clear made while the canvas is off the page (its host
      // just removed, as a closing panel's is) may never show, and it would
      // carry its last frame into the next host.
      this.renderer.setScissorTest(false);
      this.renderer.clear();
      this.renderer.setScissorTest(true);
      this.renderer.domElement.style.visibility = "hidden";
    }
  }

  private frame(dt: number) {
    const renderer = this.ensureRenderer();
    const width = window.innerWidth;
    const height = window.innerHeight;
    // Scrolling with the page: drawn a margin beyond the screen's top and
    // bottom, the canvas put over the screen (and its margins) inside the
    // host.
    const margin = this.scrolls ? Math.round(height * SCROLL_MARGIN) : 0;
    const canvasHeight = height + margin * 2;
    if (this.scrolls && this.host) {
      const h = this.host.getBoundingClientRect();
      renderer.domElement.style.transform = `translate(${-h.left}px, ${-h.top - margin}px)`;
    }

    // Where each view lands this frame, and whether it shows at all.
    const drawn: {
      view: StageView;
      rect: DOMRect;
      clip: [number, number, number, number];
      alpha: number;
    }[] = [];
    let layout = `${width}x${height}`;
    let idle = true;
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
      let top = Math.max(-margin, rect.top);
      let right = Math.min(width, rect.right);
      let bottom = Math.min(height + margin, rect.bottom);
      for (const clip of entry.clips) {
        const c = clip.getBoundingClientRect();
        left = Math.max(left, c.left);
        top = Math.max(top, c.top);
        right = Math.min(right, c.right);
        bottom = Math.min(bottom, c.bottom);
      }
      if (right <= left || bottom <= top) continue;
      const alpha = pageOpacity(el);
      if (alpha <= 0.001) continue;
      drawn.push({ view, rect, clip: [left, top, right, bottom], alpha });
      layout += `|${rect.left},${rect.top},${rect.width},${rect.height},${left},${top},${right},${bottom},${alpha}`;
      if (!view.idle()) idle = false;
    }
    // Nothing animating and nothing moved: what's on the canvas is still
    // right, so leave it (an app left open all day shouldn't redraw a paused
    // herzie sixty times a second).
    if (idle && layout === this.lastLayout) return;
    this.lastLayout = layout;

    if (renderer.getPixelRatio() !== this.pixelScale)
      renderer.setPixelRatio(this.pixelScale);
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x !== width || size.y !== canvasHeight)
      renderer.setSize(width, canvasHeight, false);
    if (this.scrolls) {
      const style = renderer.domElement.style;
      const w = `${width}px`;
      const h = `${canvasHeight}px`;
      if (style.width !== w) style.width = w;
      if (style.height !== h) style.height = h;
    }
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    for (const { view, rect, clip, alpha } of drawn) {
      view.update(dt, rect.width, rect.height, alpha);
      const [left, top, right, bottom] = clip;
      // GL's origin is the bottom left.
      renderer.setViewport(
        rect.left,
        canvasHeight - margin - rect.bottom,
        rect.width,
        rect.height,
      );
      renderer.setScissor(
        left,
        canvasHeight - margin - bottom,
        right - left,
        bottom - top,
      );
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

/** How opaque the page draws `el`: 0 when it's hidden (visibility), else its
 * own and every ancestor's opacity multiplied — what a fade on a wrapper
 * does to it. */
function pageOpacity(el: HTMLElement): number {
  // Visibility is inherited, so the element's own says it all.
  if (getComputedStyle(el).visibility !== "visible") return 0;
  let alpha = 1;
  for (
    let p: HTMLElement | null = el;
    p && p !== document.body;
    p = p.parentElement
  ) {
    const o = Number.parseFloat(getComputedStyle(p).opacity);
    if (!Number.isNaN(o)) alpha *= o;
    if (alpha <= 0) return 0;
  }
  return alpha;
}

/** The page's one stage. */
export const herzieStage = new HerzieStage();
