import type { CardIllustration } from "@herzies/shared";
import rawCardArt from "@herzies/shared/card-art/card-art.json";
import clouds from "@herzies/shared/card-art/clouds.webp";
import poseidonsGift from "@herzies/shared/card-art/poseidons-gift.webp";
import stars from "@herzies/shared/card-art/stars.webp";

/** Commissioned card illustrations, keyed by item id (the desktop's item
 * editor writes the manifest; see `@herzies/shared/card-art/`). */
const CARD_ART: Partial<Record<string, { file?: string; artist?: string }>> =
  rawCardArt;

/** Every illustration file, by name. Imported one by one so Next serves each
 * with a hashed URL; card-art.test.ts fails when the manifest names a file
 * that isn't listed here. */
const CARD_ART_URLS: Record<string, string> = {
  "clouds.webp": clouds.src,
  "poseidons-gift.webp": poseidonsGift.src,
  "stars.webp": stars.src,
};

/** The card illustration for an item, if one has been added. */
export function getCardIllustration(
  itemId: string,
): CardIllustration | undefined {
  const entry = CARD_ART[itemId];
  const url = entry?.file && CARD_ART_URLS[entry.file];
  return url ? { url, artist: entry.artist } : undefined;
}
