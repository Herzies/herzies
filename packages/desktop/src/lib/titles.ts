import {
  getTitle,
  RARITY_RANK,
  type Rarity,
  type TitleDef,
} from "@herzies/shared";

/** The rarities that get the big toast and a shimmer. */
export const isGrandRarity = (rarity: Rarity) =>
  rarity === "legendary" || rarity === "mythic";

/** How a batch of new titles is announced: each on its own, or (three or
 * more at once, as after the first launch with titles) one summary, rarest
 * first. Unknown ids (a catalog newer than this app) are skipped. */
export type TitleAnnouncement =
  | { kind: "one"; def: TitleDef }
  | { kind: "many"; defs: TitleDef[] };

export function announceTitles(ids: readonly string[]): TitleAnnouncement[] {
  const defs = ids
    .map((id) => getTitle(id))
    .filter((d): d is TitleDef => d !== undefined);
  if (defs.length >= 3) {
    return [
      {
        kind: "many",
        defs: [...defs].sort(
          (a, b) => RARITY_RANK[a.rarity] - RARITY_RANK[b.rarity],
        ),
      },
    ];
  }
  return defs.map((def) => ({ kind: "one", def }));
}

/** How rare a title is: the share of all herzies holding it, "Held by
 * 3.2% of herzies". A tenth of a percent under 10%, whole above; never
 * rounded to nothing ("<0.1%") nor, while someone lacks it, to everyone
 * ("99%"). An earned title has one holder at least: you. */
export function heldByLabel(holders: number, herzies: number): string {
  const n = Math.max(holders, 1);
  const all = Math.max(herzies, n);
  const pct = (n / all) * 100;
  if (pct < 0.1) return "Held by <0.1% of herzies";
  const shown =
    Math.round(pct * 10) < 100
      ? (Math.round(pct * 10) / 10).toFixed(1)
      : String(n < all ? Math.min(Math.round(pct), 99) : 100);
  return `Held by ${shown}% of herzies`;
}

/** An earned date as the tab says it: "3 Nov 2026". */
export function earnedOn(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
