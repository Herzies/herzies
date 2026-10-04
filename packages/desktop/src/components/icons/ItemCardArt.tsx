import type { ItemDef } from "@herzies/shared";
import rawCardArt from "../../assets/card-art/card-art.json";
import { cn } from "../../lib/utils";
import { ItemTypeIcon } from "./ItemTypeIcon";

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

/** The card's 4:3 art window content: the item's illustration, or — for any
 * item without one — its pixel icon, square at the window's full height and
 * centred (crispEdges keeps it sharp), exactly as it looks elsewhere. */
export function ItemCardArt({
  item,
  className,
}: {
  item: ItemDef;
  className?: string;
}) {
  const art = getCardIllustration(item.id);
  if (!art) {
    return (
      <div className={cn("flex justify-center", className)}>
        <ItemTypeIcon item={item} className="aspect-square h-full" />
      </div>
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
