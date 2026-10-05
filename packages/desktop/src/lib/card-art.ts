import type { CardIllustration } from "@herzies/shared";
import rawCardArt from "@herzies/shared/card-art/card-art.json";

/** Commissioned card illustrations, keyed by item id — managed in the item
 * editor (`pnpm item-editor`). `file` is the finished 4:3 image next to
 * the manifest in `@herzies/shared/card-art/` (already cropped and filtered
 * there, from the artist's original in art-sources/card-art/); `artist` is
 * printed on the card as its "Illus." credit. The manifest's other fields
 * (source, crop, filter, pixelated) are the editor's, for re-framing the
 * original later. An entry whose original was just uploaded may not have a
 * `file` yet. */
const CARD_ART: Partial<Record<string, { file?: string; artist?: string }>> =
  rawCardArt;

/** Bundled URL of every image in the folder, by file name. A relative glob:
 * Vite doesn't resolve package names in `import.meta.glob`. */
const CARD_ART_URLS = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>(
      "../../../shared/card-art/*.{png,jpg,jpeg,webp,gif,avif}",
      { eager: true, import: "default" },
    ),
  ).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1), url]),
);

/** The card illustration for an item, if one has been added. */
export function getCardIllustration(
  itemId: string,
): CardIllustration | undefined {
  const entry = CARD_ART[itemId];
  const url = entry?.file && CARD_ART_URLS[entry.file];
  return url ? { url, artist: entry.artist } : undefined;
}
