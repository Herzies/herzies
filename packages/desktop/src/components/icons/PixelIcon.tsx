import { type CSSProperties, useId } from "react";

/** Renders a bitmap (24x24 for icons, 32x24 for card artwork) as crisp SVG rects — one `<rect>` per horizontal
 * run of same-character cells. Shared by the item-type and currency pixel
 * icons so each icon set only has to describe its grid, not the rasterizer.
 *
 * Two grid dialects, picked by whether `palette` is passed:
 * - No `palette`: plain '#' filled / '.' empty, one solid fill for the whole
 *   icon (`currentColor`/`style.color`, or `gradient` if given) — what every
 *   hand-typed grid (`GRIDS`, `SORT`, `COIN_PACK`, …) still uses.
 * - `palette` given: '.' empty, '0'-'9'/'a'-'z' index into `palette` (hand-painted grids stop at 'f') — a
 *   per-pixel colour, painted in the item editor tool (see
 *   ITEM_ICON_GRIDS). A '#' cell is still allowed and still means "use the
 *   inherited solid fill", so a paletted icon can mix its own painted
 *   pixels with an unpainted currentColor/gradient fill if it wants to. */
export function PixelIcon({
  grid,
  palette,
  className,
  style,
  gradient,
  tint,
}: {
  grid: string[];
  palette?: readonly string[];
  className?: string;
  style?: CSSProperties;
  /** Colour stops for a diagonal gradient fill, overriding `currentColor`/
   * `style.color` — e.g. a set's shared rainbow clue. `useId` keeps the
   * `<linearGradient>` id collision-free when many icons render at once
   * (the inventory grid alone can have 18 on screen). */
  gradient?: readonly string[];
  /** Like `gradient`, but for a paletted icon: the gradient's hue replaces
   * the painted colours while each pixel keeps its own lightness, so the
   * icon's shading survives — e.g. a set's clue over a shaded item icon.
   * Drawn as the gradient silhouette with the painted pixels blended over it
   * in `luminosity` mode. */
  tint?: readonly string[];
}) {
  const rects: { x: number; y: number; w: number; fill?: string }[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (ch !== ".") {
        const start = x;
        while (x < row.length && row[x] === ch) x++;
        const fill =
          palette && ch !== "#" ? palette[parseInt(ch, 36)] : undefined;
        rects.push({ x: start, y, w: x - start, fill });
      } else {
        x++;
      }
    }
  });

  const gradientId = useId();
  const width = grid[0]?.length ?? grid.length;
  const stops = gradient ?? tint;

  // `painted`: each run in its palette colour; otherwise every run takes the
  // inherited fill.
  const drawRects = (painted: boolean) =>
    rects.map((r) => (
      <rect
        key={`${r.x}-${r.y}`}
        x={r.x}
        y={r.y}
        width={r.w}
        height={1}
        {...(painted && r.fill ? { fill: r.fill } : {})}
      />
    ));

  return (
    <svg
      // Sized by the grid (24x24 for icons and visitor portraits).
      viewBox={`0 0 ${width} ${grid.length}`}
      shapeRendering="crispEdges"
      fill={stops ? `url(#${gradientId})` : "currentColor"}
      aria-hidden="true"
      // Chrome treats a bare <svg> as draggable by default (unlike other
      // inline elements, and unlike what `SVGProps` even exposes a
      // `draggable` prop for) — pressing down on the icon and moving would
      // start a native image-drag gesture that hijacks the mouse event
      // stream, leaving hover/tooltip state on whatever cell the drag
      // started from stuck (see the Tooltip glitch this was fixed alongside).
      ref={(node) => node?.setAttribute("draggable", "false")}
      className={className}
      // Keeps the tint's blend to this icon's own layers.
      style={tint ? { isolation: "isolate", ...style } : style}
    >
      {stops && (
        <defs>
          {/* userSpaceOnUse (viewBox coords) so the gradient spans the whole
              icon once — the default objectBoundingBox would instead
              resolve per-rect, since `fill` is set on the <svg> and inherited
              by each individual <rect>. */}
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2={width}
            y2={grid.length}
          >
            {stops.map((color, i) => (
              <stop
                key={color}
                offset={`${(i / (stops.length - 1)) * 100}%`}
                stopColor={color}
              />
            ))}
          </linearGradient>
        </defs>
      )}
      {tint ? (
        <>
          {/* The silhouette in the gradient, then the painted pixels'
              lightness over it. */}
          {drawRects(false)}
          <g style={{ mixBlendMode: "luminosity" }}>{drawRects(true)}</g>
        </>
      ) : (
        drawRects(true)
      )}
    </svg>
  );
}
