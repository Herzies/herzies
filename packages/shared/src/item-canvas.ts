import type { Cell } from "./creature-renderer.js";

export const ITEM_FONT_FAMILY = "'SF Mono', 'Menlo', monospace";

export interface Bounds {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export interface FitMetrics {
  size: number;
  charW: number;
  lineH: number;
  canvasW: number;
  canvasH: number;
}

/** Union of non-empty cell bounds across every frame (stable while animating). */
export function contentBounds(frames: Cell[][][]): Bounds {
  let r0 = Infinity;
  let r1 = -Infinity;
  let c0 = Infinity;
  let c1 = -Infinity;
  for (const frame of frames) {
    for (let y = 0; y < frame.length; y++) {
      const row = frame[y];
      for (let x = 0; x < row.length; x++) {
        if (row[x].ch === " ") continue;
        if (y < r0) r0 = y;
        if (y > r1) r1 = y;
        if (x < c0) c0 = x;
        if (x > c1) c1 = x;
      }
    }
  }
  if (r1 < r0 || c1 < c0) return { r0: 0, r1: 0, c0: 0, c1: 0 };
  return { r0, r1, c0, c1 };
}

/** Column span (0 for an empty frame) of a single frame's non-space cells. */
function frameWidth(frame: Cell[][]): number {
  let c0 = Infinity;
  let c1 = -Infinity;
  for (const row of frame) {
    for (let x = 0; x < row.length; x++) {
      if (row[x].ch === " ") continue;
      if (x < c0) c0 = x;
      if (x > c1) c1 = x;
    }
  }
  return c1 < c0 ? 0 : c1 - c0 + 1;
}

/**
 * Index of the widest frame in an animated set. Items are baked as a card
 * spinning through a visible arc (see `generateFrames` in items.ts): the
 * frames nearest edge-on are thin slivers, and the widest frame is the one
 * facing the camera square-on — so this doubles as "pick the front-facing
 * frame" for a static (non-animated) preview, without assuming any fixed
 * index or frame count.
 */
export function widestFrameIndex(frames: Cell[][][]): number {
  let best = 0;
  let bestWidth = -1;
  for (let i = 0; i < frames.length; i++) {
    const w = frameWidth(frames[i]);
    if (w > bestWidth) {
      bestWidth = w;
      best = i;
    }
  }
  return best;
}

/** Most common non-space glyph colour in a single frame — a quick stand-in
 * for "this specific card's colour" (as opposed to a category or rarity
 * colour) without needing separate per-item colour metadata. Cards are baked
 * with a handful of discrete shade bands rather than a smooth gradient (see
 * `renderGradientCardFrame` and friends in items.ts), so the most-frequent
 * colour reliably lands on the card's actual dominant hue. */
export function dominantColor(frame: Cell[][]): string | undefined {
  const counts = new Map<string, number>();
  for (const row of frame) {
    for (const cell of row) {
      if (cell.ch === " " || !cell.color) continue;
      counts.set(cell.color, (counts.get(cell.color) ?? 0) + 1);
    }
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [color, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = color;
    }
  }
  return best;
}

/**
 * Scale the content bounds to fit (contain) within a square `box` of pixels.
 * Character cell metrics match `ItemDisplay`: width = size * 0.6, height = size
 * * 1.35.
 */
export function fitMetrics(bounds: Bounds, box: number): FitMetrics {
  const cols = bounds.c1 - bounds.c0 + 1;
  const rows = bounds.r1 - bounds.r0 + 1;
  const size = Math.max(1, Math.min(box / (cols * 0.6), box / (rows * 1.35)));
  const charW = size * 0.6;
  const lineH = size * 1.35;
  return {
    size,
    charW,
    lineH,
    canvasW: Math.ceil(cols * charW),
    canvasH: Math.ceil(rows * lineH),
  };
}

/** Draw the cropped cell grid of a single frame onto a 2D canvas context. */
export function drawFrameCells(
  ctx: CanvasRenderingContext2D,
  cells: Cell[][],
  bounds: Bounds,
  metrics: FitMetrics,
): void {
  ctx.clearRect(0, 0, metrics.canvasW, metrics.canvasH);
  ctx.font = `${metrics.size}px ${ITEM_FONT_FAMILY}`;
  ctx.textBaseline = "top";

  for (let y = bounds.r0; y <= bounds.r1; y++) {
    const row = cells[y];
    if (!row) continue;
    const py = (y - bounds.r0) * metrics.lineH;
    for (let x = bounds.c0; x <= bounds.c1; x++) {
      const cell = row[x];
      if (!cell || cell.ch === " ") continue;
      ctx.fillStyle = cell.color;
      ctx.fillText(cell.ch, (x - bounds.c0) * metrics.charW, py);
    }
  }
}

const CELL_RE = /<span style="color:([^"]*)">([\s\S])<\/span>|([\s\S])/g;

/**
 * Parse baked ASCII art frames (HTML color-span strings, as stored on
 * `ItemDef.frames`) into the same `Cell` grid the canvas renderers use.
 */
export function parseAsciiFrames(frames: string[][]): Cell[][][] {
  return frames.map((lines) =>
    lines.map((line) => {
      const cells: Cell[] = [];
      CELL_RE.lastIndex = 0;
      let m: RegExpExecArray | null = CELL_RE.exec(line);
      while (m !== null) {
        if (m[1] !== undefined) cells.push({ ch: m[2], color: m[1] });
        else cells.push({ ch: m[3], color: "" });
        m = CELL_RE.exec(line);
      }
      return cells;
    }),
  );
}
