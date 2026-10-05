import { getItemColor } from "../item-canvas.js";
import {
  getItemIconGradient,
  getItemType,
  type ItemDef,
  type ItemType,
  RARITY_COLORS,
} from "../items.js";
import { hasCardFrame } from "./artwork-from-icon.js";
import rawItemIconGrids from "./item-icon-grids.json" with { type: "json" };
import { PixelIcon } from "./PixelIcon.js";
import { TYPE_ICON_GRIDS as GRIDS } from "./type-icon-grids.js";

/** Bespoke 24x24 icon per item id, depicting what that specific item actually
 * is or does (e.g. the headphones item gets an actual pair of headphones)
 * rather than its generic type shape, painted per-pixel with simple shading
 * rather than in one solid tint — `grid` indexes into `palette` per cell
 * ('.' empty, '0'-'9'/'a'-'f' a palette slot). Falls back to `GRIDS`
 * (type-icon-grids.ts) for any item without one yet — e.g. a newly added
 * item.
 *
 * Lives in its own JSON file (rather than inline here) so the desktop's item
 * editor tool (`pnpm item-editor`, see `packages/desktop/tools/item-editor/`)
 * can read and overwrite it directly — saving there rebuilds this package,
 * which the running app picks up. */
const ITEM_ICON_GRIDS: Partial<
  Record<string, { grid: string[]; palette: string[] }>
> = rawItemIconGrids;

/** The same grids with their exact JSON type, for icons looked up by an id
 * that is known to be in the file (the visitor portraits, the Bigger Bag) —
 * not catalog items. */
export const ICON_GRID_JSON = rawItemIconGrids;

/** Chamfered card silhouette, in the same proportions as CARD_FRAME's
 * outline in type-icon-grids.ts (24x24 grid, border pixels at x=4/5/18/19,
 * y=1/2/21/22) — for clipping something else (a background tint, a solid
 * fill) into the same card shape instead of a plain square. */
export const CARD_SHAPE_CLIP =
  "polygon(20.833% 4.167%, 79.167% 4.167%, 79.167% 8.333%, 83.333% 8.333%, 83.333% 91.667%, 79.167% 91.667%, 79.167% 95.833%, 20.833% 95.833%, 20.833% 91.667%, 16.667% 91.667%, 16.667% 8.333%, 20.833% 8.333%)";

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

/** The grid an item's icon is drawn from: its bespoke paletted one, or —
 * until it has one — the generic type icon (no palette: one solid fill). */
export function getItemIcon(item: ItemDef): {
  grid: string[];
  palette?: readonly string[];
} {
  return ITEM_ICON_GRIDS[item.id] ?? { grid: GRIDS[getItemType(item)] };
}

/** Mixes `hex` toward `toward` by `amount` (0-1). */
function mixHex(hex: string, toward: string, amount: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(ch(hex, i) + (ch(toward, i) - ch(hex, i)) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Whether `rarityFrame` will paint this item's icon frame: any painted
 * card icon (the Safety Pick has no card frame). Where it doesn't, the bag
 * falls back to its corner rarity marker. */
export function hasRarityFrame(item: ItemDef): boolean {
  const bespoke = ITEM_ICON_GRIDS[item.id];
  return !!bespoke && hasCardFrame(bespoke.grid);
}

/** A card icon's frame alone, in the rarity's colour — the same clue as the
 * opened card's frame — keeping the frame's shading: its four corner
 * highlights lightest, top and left lit, right and bottom in shadow. Drawn
 * as an overlay, so a set's gradient tint (on the picture) leaves it be. */
function rarityFrameOverlay(rarityColor: string): {
  grid: string[];
  palette: string[];
} {
  const corners = new Set(["5,2", "18,2", "5,21", "18,21"]);
  const grid = Array.from({ length: 24 }, (_, y) =>
    Array.from({ length: 24 }, (_, x) => {
      if (corners.has(`${x},${y}`)) return "0";
      const inFrameRows = y >= 2 && y <= 21;
      if ((y === 1 && x >= 5 && x <= 18) || (x === 4 && inFrameRows))
        return "1";
      if ((y === 22 && x >= 5 && x <= 18) || (x === 19 && inFrameRows))
        return "2";
      return ".";
    }).join(""),
  );
  return {
    grid,
    palette: [
      mixHex(rarityColor, "#ffffff", 0.45),
      rarityColor,
      mixHex(rarityColor, "#000000", 0.45),
    ],
  };
}

export function ItemTypeIcon({
  item,
  className,
  rarityFrame = false,
}: {
  item: ItemDef;
  className?: string;
  /** Paint the icon's card frame in the item's rarity colour (see
   * hasRarityFrame for which icons it applies to). */
  rarityFrame?: boolean;
}) {
  const type = getItemType(item);
  const bespoke = ITEM_ICON_GRIDS[item.id];
  const overlay =
    rarityFrame && hasRarityFrame(item)
      ? rarityFrameOverlay(RARITY_COLORS[item.rarity])
      : undefined;
  const gradient = getItemIconGradient(item.id);

  if (gradient) {
    // A set's shared visual clue (e.g. Prismatic's rainbow) overrides the
    // colours this item's own icon was painted in, so members read as
    // related regardless of them — but the icon's shape and shading carry
    // over (the gradient tints it). Unless the set exempts the item
    // (visualExempt).
    if (bespoke) {
      return (
        <PixelIcon
          grid={bespoke.grid}
          palette={bespoke.palette}
          className={className}
          tint={gradient}
          overlay={overlay}
        />
      );
    }
    return (
      <PixelIcon grid={GRIDS[type]} className={className} gradient={gradient} />
    );
  }

  if (bespoke) {
    return (
      <PixelIcon
        grid={bespoke.grid}
        palette={bespoke.palette}
        className={className}
        overlay={overlay}
      />
    );
  }

  // No bespoke icon yet: the generic per-type pip, tinted with this item's
  // own dominant-colour tint (sampled from its card art).
  return (
    <PixelIcon
      grid={GRIDS[type]}
      className={className}
      style={{ color: getItemColor(item) }}
    />
  );
}
