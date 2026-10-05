import { getItemColor } from "../item-canvas.js";
import { getItemIconGradient, type ItemDef } from "../items.js";
import { artworkFromIcon } from "./artwork-from-icon.js";
import { cx } from "./cx.js";
import { getItemIcon } from "./ItemTypeIcon.js";
import rawArtworkGrids from "./item-artwork-grids.json" with { type: "json" };
import { PixelIcon } from "./PixelIcon.js";

/** A commissioned card illustration: the finished 4:3 image's URL and the
 * artist credited on the card. Each app resolves the URL itself (the files
 * live in `@herzies/shared/card-art/`, listed in its `card-art.json`), since
 * how an image becomes a URL is up to its bundler. */
export interface CardIllustration {
  url: string;
  artist?: string;
}

/** Hand-edited pixel artwork, keyed by item id (32x24, the icon's
 * `{ palette, grid }` dialect) — painted in the item editor's Artwork tab.
 * An item without an entry derives its artwork from its icon instead (see
 * artworkFromIcon), so icon edits keep flowing through until the artwork is
 * edited on its own. */
const ARTWORK_GRIDS: Partial<
  Record<string, { grid: string[]; palette: string[] }>
> = rawArtworkGrids;

/** The item's pixel artwork: its own, or derived from its icon. */
export function getItemArtwork(item: ItemDef): {
  grid: string[];
  palette?: readonly string[];
} {
  const own = ARTWORK_GRIDS[item.id];
  if (own) return own;
  const icon = getItemIcon(item);
  return { grid: artworkFromIcon(icon.grid), palette: icon.palette };
}

/** The card's 4:3 art window content: the item's uploaded illustration, or
 * its pixel artwork (32x24, at 6x — crispEdges keeps it sharp), coloured
 * exactly as the item's icon is (a set's gradient tints it too). */
export function ItemCardArt({
  item,
  illustration,
  className,
}: {
  item: ItemDef;
  illustration?: CardIllustration;
  className?: string;
}) {
  if (!illustration) {
    const { grid, palette } = getItemArtwork(item);
    const gradient = getItemIconGradient(item.id);
    return (
      <PixelIcon
        grid={grid}
        palette={palette}
        className={className}
        {...(gradient
          ? palette
            ? { tint: gradient }
            : { gradient }
          : palette
            ? {}
            : // The generic type icon's solid fill, as on the icon.
              { style: { color: getItemColor(item) } })}
      />
    );
  }
  return (
    <img
      src={illustration.url}
      alt={item.name}
      draggable={false}
      className={cx("object-cover", className)}
    />
  );
}
