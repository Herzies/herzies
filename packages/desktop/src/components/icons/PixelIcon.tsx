import type { CSSProperties } from "react";

/** Renders a 16x16 bitmap ('#' filled / '.' empty, one string per row) as
 * crisp SVG rects — one `<rect>` per horizontal run of filled cells. Shared
 * by the item-type and currency pixel icons so each icon set only has to
 * describe its grid, not the rasterizer. */
export function PixelIcon({
  grid,
  className,
  style,
}: {
  grid: string[];
  className?: string;
  style?: CSSProperties;
}) {
  const rects: { x: number; y: number; w: number }[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] === "#") {
        const start = x;
        while (x < row.length && row[x] === "#") x++;
        rects.push({ x: start, y, w: x - start });
      } else {
        x++;
      }
    }
  });

  return (
    <svg
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden="true"
      // Chrome treats a bare <svg> as draggable by default (unlike other
      // inline elements, and unlike what `SVGProps` even exposes a
      // `draggable` prop for) — pressing down on the icon and moving would
      // start a native image-drag gesture that hijacks the mouse event
      // stream, leaving hover/tooltip state on whatever cell the drag
      // started from stuck (see the Tooltip glitch this was fixed alongside).
      ref={(node) => node?.setAttribute("draggable", "false")}
      className={className}
      style={style}
    >
      {rects.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} />
      ))}
    </svg>
  );
}
