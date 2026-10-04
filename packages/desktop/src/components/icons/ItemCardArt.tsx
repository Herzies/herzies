import {
  getItemColor,
  getItemIconGradient,
  type ItemDef,
} from "@herzies/shared";
import rawCardArt from "../../assets/card-art/card-art.json";
import { cn } from "../../lib/utils";
import { artworkFromIcon } from "./artwork-from-icon";
import { getItemIcon } from "./ItemTypeIcon";
import rawArtworkGrids from "./item-artwork-grids.json";
import { PixelIcon } from "./PixelIcon";

/** Commissioned card illustrations, keyed by item id — managed in the item
 * editor (`pnpm item-editor`). `file` is the finished 4:3 image next to
 * this manifest (already cropped and filtered there, from the artist's
 * original in art-sources/card-art/); `artist` is printed on the card as
 * its "Illus." credit. The manifest's other fields (source, crop, filter,
 * pixelated) are the editor's, for re-framing the original later. An entry
 * whose original was just uploaded may not have a `file` yet. */
const CARD_ART: Partial<Record<string, { file?: string; artist?: string }>> =
  rawCardArt;

/** Bundled URL of every image in the folder, by file name. */
const CARD_ART_URLS = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>(
      "../../assets/card-art/*.{png,jpg,jpeg,webp,gif,avif}",
      { eager: true, import: "default" },
    ),
  ).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1), url]),
);

/** The card illustration for an item, if one has been added. */
export function getCardIllustration(
  itemId: string,
): { url: string; artist?: string } | undefined {
  const entry = CARD_ART[itemId];
  const url = entry?.file && CARD_ART_URLS[entry.file];
  return url ? { url, artist: entry.artist } : undefined;
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
  className,
}: {
  item: ItemDef;
  className?: string;
}) {
  const art = getCardIllustration(item.id);
  if (!art) {
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
      src={art.url}
      alt={item.name}
      draggable={false}
      className={cn("object-cover", className)}
    />
  );
}
