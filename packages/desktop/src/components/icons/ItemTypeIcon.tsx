import {
  getItemColor,
  getItemSet,
  getItemType,
  type ItemDef,
  type ItemType,
} from "@herzies/shared";
import rawItemIconGrids from "./item-icon-grids.json";
import { PixelIcon } from "./PixelIcon";

/** Bespoke 16x16 pip per item id, depicting what that specific item actually
 * is or does (e.g. the headphones item gets an actual pair of headphones)
 * rather than its generic type shape. Falls back to `GRIDS` below for any
 * item without one yet — e.g. a newly added item.
 *
 * Lives in its own JSON file (rather than inline here) so the icon-editor
 * tool (`pnpm icon-editor`, see `tools/icon-editor/`) can read and overwrite
 * it directly — editing a shape there and saving takes effect immediately,
 * the same live-reload any other source edit gets. */
const ITEM_ICON_GRIDS: Partial<Record<string, string[]>> = rawItemIconGrids;

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
  // Three diagonal pips — a die face, distinct from modifier's single
  // up-arrow and equipable's shield.
  dice: cardIcon(
    ["##......", "........", "..##....", "........", "....##.."],
    6,
  ),
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

/** Generic per-type pip with no item-specific art or colour — used only when
 * an equipped itemId is missing from the catalog (stale/desynced data), so
 * the slot still renders something instead of looking empty. */
export function GenericTypeIcon({
  type,
  className,
}: {
  type: ItemType;
  className?: string;
}) {
  return <PixelIcon grid={GRIDS[type]} className={className} />;
}

export function ItemTypeIcon({
  item,
  className,
}: {
  item: ItemDef;
  className?: string;
}) {
  const type = getItemType(item);
  const grid = ITEM_ICON_GRIDS[item.id] ?? GRIDS[type];
  const set = getItemSet(item.id);
  return (
    <PixelIcon
      grid={grid}
      className={className}
      // A set's shared visual clue (e.g. Prismatic's rainbow) overrides this
      // item's own dominant-colour tint, so members read as related
      // regardless of their individual icon shape.
      style={set?.visual ? undefined : { color: getItemColor(item) }}
      gradient={set?.visual?.gradient}
    />
  );
}
