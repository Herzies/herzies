import {
  BOSS_BODY_TYPE,
  type Equipped,
  GEORGE_EQUIPPED,
  GEORGE_SEED,
  generateCreatureParams,
  ORPHIEZ_EQUIPPED,
  PixelIcon,
  ICON_GRID_JSON as rawItemIconGrids,
  renderCreatureAtAngle,
  VISITORS,
} from "@herzies/shared";
import { useMemo } from "react";
import { cn } from "../../lib/utils";

// Hand-tweaked portraits, painted in the item editor (`pnpm item-editor`,
// listed there under EXTRA_ICONS) and stored beside the item icons. A
// visitor with one shows it; one without (every boss, each with its own
// face) is drawn from their 3D look below. The seeded entries began as a
// 24x24 snapshot of exactly that drawing, so an untouched one looks the same.
const PAINTED: Record<string, { grid: string[]; palette: string[] }> = {
  song_hunt: rawItemIconGrids["visitor-orphiez"],
  merchant: rawItemIconGrids["visitor-george"],
};

// The renderer's cell box (see Herzie3D's metrics): glyphs are 0.6 wide and
// 1.35 tall per unit of font size, so a portrait built from its cells has to
// keep that ratio or the creature comes out squashed.
const CELL_W = 0.6;
const CELL_H = 1.35;

type Portrait = {
  viewBox: string;
  rects: { x: number; y: number; w: number; fill: string }[];
};

// A portrait is one render of a fixed creature, so it's worked out once per
// look and shared by every row that shows it.
const portraitCache = new Map<string, Portrait | null>();

/** The visitor's actual 3D look, face-on and at rest, as crisp SVG: every
 * filled cell of the renderer's frame becomes a rect in that cell's colour,
 * cropped to the creature. The same creature the visitor's own screen
 * shows, just tiny. */
function portraitFor(type: string, seed: string | undefined): Portrait | null {
  const key = `${type}:${seed ?? ""}`;
  const cached = portraitCache.get(key);
  if (cached !== undefined) return cached;

  let cells: { ch: string; color: string }[][] | null = null;
  const at = (
    userId: string,
    stage: number,
    equipped?: Equipped,
    params?: ReturnType<typeof generateCreatureParams>,
  ) => renderCreatureAtAngle(userId, stage, 0, 0, false, equipped, params, 64);
  if (type === "song_hunt") {
    cells = at(
      VISITORS.song_hunt.seed ?? "npc:orphiez",
      2,
      ORPHIEZ_EQUIPPED,
    ).cells;
  } else if (type === "merchant") {
    cells = at(GEORGE_SEED, 2, GEORGE_EQUIPPED).cells;
  } else if (type === "boss_fight") {
    // Each boss looks different (seeded by its event, as in BossFightPanel),
    // so a live or scheduled boss shows its own face.
    const userId = `boss:${seed ?? "town"}`;
    cells = at(userId, 3, undefined, {
      ...generateCreatureParams(userId),
      bodyType: BOSS_BODY_TYPE,
    }).cells;
  }

  let portrait: Portrait | null = null;
  if (cells) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    const rects: Portrait["rects"] = [];
    cells.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const fill = row[x].color;
        if (row[x].ch === " ") {
          x++;
          continue;
        }
        const start = x;
        while (x < row.length && row[x].ch !== " " && row[x].color === fill) {
          x++;
        }
        rects.push({ x: start, y, w: x - start, fill });
        x0 = Math.min(x0, start);
        x1 = Math.max(x1, x - 1);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    });
    if (rects.length > 0) {
      portrait = {
        viewBox: `${x0 * CELL_W} ${y0 * CELL_H} ${(x1 - x0 + 1) * CELL_W} ${(y1 - y0 + 1) * CELL_H}`,
        rects,
      };
    }
  }
  portraitCache.set(key, portrait);
  return portrait;
}

/** A visitor's portrait for their Town row: in colour and idling while
 * they're in town, grey and still while they're away (the row itself
 * already dims an away visitor, so no extra fade here). Renders nothing for a
 * visitor type without a look. */
export function VisitorIcon({
  type,
  seed,
  inTown,
  className,
}: {
  type: string;
  /** Per-visit seed — only the boss uses it (its event id). */
  seed?: string;
  inTown: boolean;
  className?: string;
}) {
  const painted = PAINTED[type];
  const portrait = useMemo(
    () => (painted ? null : portraitFor(type, seed)),
    [painted, type, seed],
  );
  const motion = inTown ? "animate-visitor-bob" : "grayscale";
  if (painted) {
    return (
      <PixelIcon
        grid={painted.grid}
        palette={painted.palette}
        className={cn(motion, className)}
      />
    );
  }
  if (!portrait) return null;
  return (
    <svg
      viewBox={portrait.viewBox}
      shapeRendering="crispEdges"
      aria-hidden="true"
      className={cn(motion, className)}
    >
      {portrait.rects.map((r) => (
        <rect
          key={`${r.x}-${r.y}`}
          x={r.x * CELL_W}
          y={r.y * CELL_H}
          // A hair of overlap so neighbouring runs never show a seam at
          // fractional pixel sizes.
          width={r.w * CELL_W + 0.02}
          height={CELL_H + 0.02}
          fill={r.fill}
        />
      ))}
    </svg>
  );
}
