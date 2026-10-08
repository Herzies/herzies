import { dot3, LIGHT, RAMP_HERZIE, VIOLET_RAMP } from "@herzies/shared";
import { useEffect, useRef } from "react";
import { cn } from "../lib/utils";
import { BANNER } from "./banner";

/**
 * Full-screen cover while the app has nothing complete to show yet: before
 * the first state arrives at launch, and while a login loads the herzie and
 * its items. Showing the half-loaded UI instead flashes the wrong screen
 * (the logged-out splash, a herzie with no items, a bag that reads as full).
 *
 * `overlay` covers the whole window from inside a view that is still
 * loading (Town), rather than standing in for the app as a screen.
 */
export function LoadingSplash({
  label,
  overlay = false,
}: {
  label?: string;
  overlay?: boolean;
}) {
  return (
    <div
      data-tauri-drag-region
      role="status"
      aria-live="polite"
      className={cn(
        "loading-splash flex flex-col items-center justify-center gap-6",
        overlay ? "fixed inset-0 z-1000 bg-bg-panel" : "h-screen",
      )}
    >
      <pre
        aria-hidden="true"
        className="loading-splash-banner m-0 text-sm leading-[1.15] text-purple"
      >
        {BANNER}
      </pre>
      <div className="flex flex-col items-center gap-2.5">
        <LoadingBeads />
        <div className="h-4 text-ui text-text-dim">
          {label ?? <span className="sr-only">loading</span>}
        </div>
      </div>
    </div>
  );
}

// Drawn like Herzie3D: lit spheres raycast onto a grid of RAMP_HERZIE glyphs
// at the same cell metrics, coloured from the Purple Dane ramp. A swell runs
// along a row of beads, lifting and lighting each in turn, and wraps.
const FONT_SIZE = 5;
const CHAR_W = FONT_SIZE * 0.6;
const LINE_H = FONT_SIZE * 1.35;
const BEADS = 6;
const SPACING = 30;
const REST_R = 8;
const SWELL_R = 13;
const LIFT = 6;
const COLS = Math.ceil((BEADS * SPACING) / CHAR_W);
const ROWS = 7;
const W = Math.ceil(COLS * CHAR_W);
const H = Math.ceil(ROWS * LINE_H);
const FRAME_MS = 50;
/** One pass of the swell, entering left and leaving right. */
const SWEEP_MS = 1400;

function drawBeads(ctx: CanvasRenderingContext2D, t: number) {
  // Swell centre in bead units, overshooting both ends so it enters and
  // leaves the row instead of popping in on the first bead.
  const centre = -1.5 + ((t % SWEEP_MS) / SWEEP_MS) * (BEADS + 2);
  const beads = Array.from({ length: BEADS }, (_, i) => {
    const swell = Math.exp(-((i - centre) ** 2) / 1.1);
    return {
      x: (i + 0.5) * SPACING,
      y: H / 2 + LIFT / 2 - swell * LIFT,
      r: REST_R + (SWELL_R - REST_R) * swell,
      swell,
    };
  });

  ctx.clearRect(0, 0, W, H);
  ctx.font = `${FONT_SIZE}px 'SF Mono', 'Menlo', monospace`;
  ctx.textBaseline = "top";
  for (let row = 0; row < ROWS; row++) {
    const py = (row + 0.5) * LINE_H;
    for (let col = 0; col < COLS; col++) {
      const px = (col + 0.5) * CHAR_W;
      // Nearest surface toward the viewer, as the creature raycast picks it.
      let best: {
        nx: number;
        ny: number;
        nz: number;
        depth: number;
        swell: number;
      } | null = null;
      for (const b of beads) {
        const dx = (px - b.x) / b.r;
        const dy = (py - b.y) / b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= 1) continue;
        const nz = -Math.sqrt(1 - d2);
        const depth = nz * b.r;
        if (!best || depth < best.depth)
          best = { nx: dx, ny: dy, nz, depth, swell: b.swell };
      }
      if (!best) continue;
      const diffuse = Math.max(0, dot3([best.nx, best.ny, best.nz], LIGHT));
      const lit = (0.15 + 0.85 * diffuse) * (0.35 + 0.65 * best.swell);
      const idx = Math.round((1 - lit) * (VIOLET_RAMP.length - 1));
      ctx.fillStyle = VIOLET_RAMP[idx];
      ctx.fillText(RAMP_HERZIE, col * CHAR_W, row * LINE_H);
    }
  }
}

function LoadingBeads() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    // Reduced motion: hold one frame with the swell mid-row.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      drawBeads(ctx, SWEEP_MS * 0.5);
      return;
    }
    const start = performance.now();
    const tick = () => drawBeads(ctx, performance.now() - start);
    tick();
    const id = setInterval(tick, FRAME_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={W}
      height={H}
      style={{ width: W, height: H, imageRendering: "pixelated" }}
    />
  );
}
