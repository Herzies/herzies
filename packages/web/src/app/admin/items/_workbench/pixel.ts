/** Pixel grids as the item art files store them: rows of '.' (empty) or a
 * hex index into `palette`. 24x24 for icons, 32x24 for card artwork. */
export type PixelArt = { grid: string[]; palette: string[] };

export const MAX_PALETTE = 16;

/** Shown where a pixel is empty. */
export const EMPTY_PIXEL = "#05060a";

export function dims(grid: string[]): { w: number; h: number } {
  return { w: grid[0]?.length ?? 0, h: grid.length };
}

export function colorForChar(ch: string, palette: string[]): string | null {
  if (ch === ".") return null;
  return palette[Number.parseInt(ch, 16)] ?? "#ff00ff";
}

/**
 * Draws a grid at 1px per pixel. `gradient`: a set's shared clue (e.g.
 * Prismatic's rainbow), which the app tints the icon with, keeping each
 * pixel's own lightness, so the preview shows that too.
 */
export function drawGrid(
  canvas: HTMLCanvasElement,
  art: PixelArt,
  gradient?: string[] | null,
): void {
  const { w, h } = dims(art.grid);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  if (gradient && gradient.length > 0) {
    const fill = ctx.createLinearGradient(0, 0, w, h);
    const denom = gradient.length > 1 ? gradient.length - 1 : 1;
    gradient.forEach((color, i) => {
      fill.addColorStop(i / denom, color);
    });
    ctx.fillStyle = fill;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (art.grid[y][x] !== ".") ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.globalCompositeOperation = "luminosity";
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const color = colorForChar(art.grid[y][x], art.palette);
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.globalCompositeOperation = "source-over";
}
