import { mulberry32 } from "@herzies/shared";

// Chunky pixel clouds drifting slowly across the sky behind a page (the
// about page's, see data-sky in globals.css), scattered down its whole
// height so they scroll with it. Fills its nearest positioned ancestor.
// Plain SVG and a CSS animation: no script runs once the page is drawn.

/** Spread down the whole page, which is many screens tall. */
const COUNT = 26;

type Cloud = {
  /** The cloud's pixel rows, as runs: [y, x, length, shade]. */
  runs: [number, number, number, boolean][];
  cols: number;
  rows: number;
  top: number;
  /** One cloud pixel, in whole CSS px (so its edges stay crisp). */
  px: number;
  opacity: number;
  /** Seconds to cross the screen, and how far into that it starts. */
  duration: number;
  delay: number;
};

/** A cloud's outline: a flat-bottomed heap of lumps, pixel by pixel, its
 * bottom row a shade darker. */
function cloudShape(rand: () => number): Pick<Cloud, "runs" | "cols" | "rows"> {
  const cols = 14 + Math.floor(rand() * 14);
  const rows = 5 + Math.floor(rand() * 3);
  const lumps = Array.from({ length: 2 + Math.floor(rand() * 3) }, () => ({
    x: cols * (0.2 + rand() * 0.6),
    r: rows * (0.45 + rand() * 0.45),
  }));
  const inside = (x: number, y: number) => {
    // y counts up from the bottom row; the bottom two rows are the base.
    if (y < 2) return x >= cols * 0.08 && x < cols * 0.92;
    return lumps.some((l) => {
      const dx = (x + 0.5 - l.x) / (l.r * 1.4);
      const dy = (y + 0.5 - 1) / l.r;
      return dx * dx + dy * dy <= 1;
    });
  };
  const runs: Cloud["runs"] = [];
  for (let y = 0; y < rows; y++) {
    let start = -1;
    for (let x = 0; x <= cols; x++) {
      const on = x < cols && inside(x, y);
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        runs.push([rows - 1 - y, start, x - start, y === 0]);
        start = -1;
      }
    }
  }
  return { runs, cols, rows };
}

/** The same clouds on the server and in the browser (a fixed seed). */
const CLOUDS: Cloud[] = (() => {
  const rand = mulberry32(20261029);
  return Array.from({ length: COUNT }, (_, i) => {
    const duration = 140 + rand() * 120;
    return {
      ...cloudShape(rand),
      // Spread down the screen, a band each, jittered.
      top: ((i + rand() * 0.8) / COUNT) * 100,
      px: 4 + Math.floor(rand() * 4),
      opacity: 0.75 + rand() * 0.25,
      duration,
      // Negative: already part way across when the page opens.
      delay: -rand() * duration,
    };
  });
})();

export function SkyClouds() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
    >
      {CLOUDS.map((c, i) => (
        <svg
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
          key={i}
          aria-hidden="true"
          className="sky-cloud absolute left-0"
          width={c.cols * c.px}
          height={c.rows * c.px}
          viewBox={`0 0 ${c.cols} ${c.rows}`}
          shapeRendering="crispEdges"
          style={{
            top: `${c.top}%`,
            opacity: c.opacity,
            animationDuration: `${c.duration}s`,
            animationDelay: `${c.delay}s`,
          }}
        >
          {c.runs.map(([y, x, w, shade]) => (
            <rect
              key={`${y}-${x}`}
              x={x}
              y={y}
              width={w}
              height={1}
              fill={shade ? "#dce9f5" : "#ffffff"}
            />
          ))}
        </svg>
      ))}
    </div>
  );
}
