import { useMemo } from "react";

/** CSS px per sprite pixel: the herzie stage's own (it draws at a quarter
 * of the screen's resolution), so the sprites sit with the portrait. */
export const PIXEL = 4;

export type PixelCrystalLook = "lit" | "next" | "locked";

/** Colours, darkest to brightest, hue-shifted (cool shade, white light). */
const PALETTES: Record<
  PixelCrystalLook,
  { line: string; deep: string; mid: string; light: string; shine: string }
> = {
  lit: {
    line: "#16305c",
    deep: "#2f7fb8",
    mid: "#4fc4e6",
    light: "#9ff0ff",
    shine: "#ffffff",
  },
  next: {
    line: "#7fe8ff",
    deep: "#1d3346",
    mid: "#244158",
    light: "#2e5470",
    shine: "#5f9fbf",
  },
  locked: {
    line: "#3a3a46",
    deep: "#24242c",
    mid: "#292932",
    light: "#2f2f3a",
    shine: "#2f2f3a",
  },
};

type Px = { x: number; y: number; c: keyof (typeof PALETTES)["lit"] };

/** The sprite's pixels: a long diamond `h` tall, its left facets in the
 * light, its right in shade, an outline round it and a glint up top. */
function crystalPixels(h: number): { w: number; px: Px[] } {
  const half = Math.max(1, Math.round(h * 0.27));
  const w = half * 2 + 1;
  const mid = Math.round((h - 1) * 0.42);
  const c = half;
  const reach = (y: number) =>
    y <= mid
      ? Math.round((y / mid) * half)
      : Math.round(((h - 1 - y) / (h - 1 - mid)) * half);
  const px: Px[] = [];
  for (let y = 0; y < h; y++) {
    const r = reach(y);
    for (let x = c - r; x <= c + r; x++) {
      // On the edge: its own reach, or the row above/below doesn't cover it.
      const edge =
        x === c - r ||
        x === c + r ||
        y === 0 ||
        y === h - 1 ||
        Math.abs(x - c) > reach(y - 1) ||
        Math.abs(x - c) > reach(y + 1);
      let col: Px["c"];
      if (edge) col = "line";
      else if (x < c) col = y <= mid ? "light" : "mid";
      else if (x === c) col = y <= mid ? "light" : "deep";
      else col = y <= mid ? "mid" : "deep";
      px.push({ x, y, c: col });
    }
  }
  // The glint: a short streak down the upper-left facet.
  for (let k = 0; k < Math.max(1, Math.floor(h / 6)); k++) {
    const y = 2 + k;
    const x = c - 1 - Math.floor(k / 2);
    const hit = px.find((p) => p.x === x && p.y === y && p.c !== "line");
    if (hit) hit.c = "shine";
  }
  return { w, px };
}

/** A pixel-art crystal, `h` sprite pixels tall. */
export function PixelCrystal({
  h,
  look,
  className,
}: {
  h: number;
  look: PixelCrystalLook;
  className?: string;
}) {
  const { w, px } = useMemo(() => crystalPixels(h), [h]);
  const pal = PALETTES[look];
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={w * PIXEL}
      height={h * PIXEL}
      shapeRendering="crispEdges"
      className={className}
      aria-hidden="true"
    >
      {px.map((p) => (
        <rect
          key={`${p.x},${p.y}`}
          x={p.x}
          y={p.y}
          width={1}
          height={1}
          fill={pal[p.c]}
        />
      ))}
    </svg>
  );
}
