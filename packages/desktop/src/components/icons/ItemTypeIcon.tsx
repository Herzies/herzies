import type { ItemType } from "@herzies/shared";
import type { CSSProperties } from "react";
import { PixelIcon } from "./PixelIcon";

// Every item is a card (the store's buy tab is literally called "Cards"), so
// each type icon is the same chamfered-corner card outline with a small pip
// marking the category — like a suit mark on a playing card.
const CARD_FRAME = [
  "................",
  "....########....",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "....########....",
  "................",
];

function cardIcon(pipRows: string[], startRow: number): string[] {
  const rows = [...CARD_FRAME];
  pipRows.forEach((seg, i) => {
    const r = startRow + i;
    rows[r] = rows[r].slice(0, 4) + seg + rows[r].slice(12);
  });
  return rows;
}

/** Chamfered card silhouette, in the same proportions as CARD_FRAME's
 * outline above (16x16 grid, border pixels at x=3/4/12/13, y=1/2/14/15) —
 * for clipping something else (a background tint, a solid fill) into the
 * same card shape instead of a plain square. */
export const CARD_SHAPE_CLIP =
  "polygon(25% 6.25%, 75% 6.25%, 75% 12.5%, 81.25% 12.5%, 81.25% 87.5%, 75% 87.5%, 75% 93.75%, 25% 93.75%, 25% 87.5%, 18.75% 87.5%, 18.75% 12.5%, 25% 12.5%)";

const GRIDS: Record<ItemType, string[]> = {
  // Paint drop — appearance/palette, no hue needed to read as "color".
  skin: cardIcon(
    ["...##...", "..####..", "..####..", "..####..", "...##..."],
    6,
  ),
  // Sun + mountain — background scenery.
  sceneryCard: cardIcon(
    [".....##.", ".....##.", "...##...", "..####..", ".######."],
    6,
  ),
  // Shield — generic catch-all gear.
  equipable: cardIcon(
    ["..####..", "..####..", "...##...", "...##...", "...##..."],
    5,
  ),
  // Ribboned box — a placed prop, not something worn.
  accessory: cardIcon(
    [".######.", ".##..##.", ".##..##.", ".##..##.", ".######."],
    6,
  ),
  // Up-arrow — a stat-changing effect.
  modifier: cardIcon(
    ["...##...", "..####..", "...##...", "...##...", "...##..."],
    6,
  ),
  // Faceted gem — rare, uncategorized treasure.
  artefact: cardIcon(["..####..", ".######.", "..####..", "...##..."], 6),
};

export function ItemTypeIcon({
  type,
  className,
  style,
}: {
  type: ItemType;
  className?: string;
  /** e.g. `{ color: "#..." }` to override the default category colour. */
  style?: CSSProperties;
}) {
  return <PixelIcon grid={GRIDS[type]} className={className} style={style} />;
}
