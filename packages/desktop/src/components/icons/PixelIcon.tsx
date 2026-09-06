/** Renders a 16x16 bitmap ('#' filled / '.' empty, one string per row) as
 * crisp SVG rects — one `<rect>` per horizontal run of filled cells. Shared
 * by the item-type and currency pixel icons so each icon set only has to
 * describe its grid, not the rasterizer. */
export function PixelIcon({
  grid,
  className,
}: {
  grid: string[];
  className?: string;
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
      className={className}
    >
      {rects.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} />
      ))}
    </svg>
  );
}
