import type { ItemType } from "@herzies/shared";
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
}: {
  type: ItemType;
  className?: string;
}) {
  return <PixelIcon grid={GRIDS[type]} className={className} />;
}
