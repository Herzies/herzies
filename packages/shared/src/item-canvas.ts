import type { Cell } from "./creature-renderer.js";
import { getItemType, type ItemDef } from "./items.js";

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
 *
 * `fillFraction` (default 1, i.e. fill the box like every card-shaped item
 * does) shrinks the *target* the content is fit into, not the content's own
 * character-count budget — see `previewFillFraction`. Shrinking `bounds`
 * itself instead (by baking a smaller object in items.ts) would look
 * identical at this box size but be strictly lower-resolution: fewer source
 * characters get stretched to cover the same on-screen area rather than
 * more of them filling less of it.
 */
export function fitMetrics(
  bounds: Bounds,
  box: number,
  fillFraction = 1,
): FitMetrics {
  const cols = bounds.c1 - bounds.c0 + 1;
  const rows = bounds.r1 - bounds.r0 + 1;
  const target = box * fillFraction;
  const size = Math.max(
    1,
    Math.min(target / (cols * 0.6), target / (rows * 1.35)),
  );
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

/** How much of its preview box an item's content should fill — passed
 * straight through to `fitMetrics`'s `fillFraction`. 1 (fill it) for every
 * card-shaped item, same as always. Power Dice is the one exception: its
 * cube is baked at (close to) the same character-count budget as a card —
 * deliberately, so it's just as detailed — but a die sitting next to a card
 * should still read as the smaller physical object. Doing that here, by
 * asking for less of the box, keeps the full source resolution and only
 * changes the final on-screen size — the opposite of shrinking the baked
 * geometry, which (see the note on `fitMetrics`) changes the size not at
 * all and only costs resolution. */
export function previewFillFraction(item: { dice?: boolean }): number {
  return item.dice ? 0.62 : 1;
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

const itemColorCache = new Map<string, string>();

/** This item's own dominant colour, sampled from its baked art's
 * front-facing frame (see `dominantColor`/`widestFrameIndex` above) —
 * distinct from a category or rarity colour, this is what that specific card
 * actually looks like. Memoized per item id since the underlying art never
 * changes at runtime.
 *
 * Lives here rather than in items.ts so that items.ts carries no dependency on
 * the rendering chain: it is shared verbatim with the Deno edge functions
 * (see game-rules.ts), which have no canvas. */
export function getItemColor(item: ItemDef): string {
  const cached = itemColorCache.get(item.id);
  if (cached) return cached;
  const frames = parseAsciiFrames(item.frames);
  const front = frames[widestFrameIndex(frames)] ?? frames[0];
  const color = (front && dominantColor(front)) || "#ffffff";
  itemColorCache.set(item.id, color);
  return color;
}
