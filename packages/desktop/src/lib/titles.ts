import {
  getTitle,
  RARITY_COLORS,
  type Rarity,
  TITLES,
  type TitleDef,
} from "@herzies/shared";

/** Rarest first. */
export const RARITY_RANK: Record<Rarity, number> = {
  mythic: 0,
  legendary: 1,
  rare: 2,
  uncommon: 3,
  common: 4,
};

/** The rarities that get the big toast and a shimmer. */
export const isGrandRarity = (rarity: Rarity) =>
  rarity === "legendary" || rarity === "mythic";

/** A title's colour: its rarity's, as items have. */
export function titleColour(id: string | null | undefined): string | null {
  const def = getTitle(id);
  return def ? RARITY_COLORS[def.rarity] : null;
}

/** One ladder (titles on the same number, low to high), or a lone title. */
export interface TitleFamily {
  key: string;
  rungs: TitleDef[];
}

/** The catalog as the Titles tab lists it: in its own order, each ladder
 * (neighbouring titles of one category on the same metric) as one family. */
export function titleFamilies(
  catalog: readonly TitleDef[] = TITLES,
): TitleFamily[] {
  const families: TitleFamily[] = [];
  for (const def of catalog) {
    const last = families.at(-1)?.rungs.at(-1);
    if (
      last &&
      def.metric &&
      last.metric === def.metric &&
      last.category === def.category
    ) {
      families[families.length - 1].rungs.push(def);
    } else {
      families.push({ key: def.id, rungs: [def] });
    }
  }
  return families;
}

/** The rungs of a ladder the tab shows: folded, the highest one earned and
 * the next one to go for (the first, before any is earned); open, all of
 * them. A ladder of two shows both either way. */
export function shownRungs(
  family: TitleFamily,
  earned: ReadonlySet<string>,
  open: boolean,
): TitleDef[] {
  const { rungs } = family;
  if (open || rungs.length <= 2) return rungs;
  let top = -1;
  rungs.forEach((r, i) => {
    if (earned.has(r.id)) top = i;
  });
  if (top < 0) return [rungs[0]];
  return rungs.slice(top, top + 2);
}

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

/** "Held by 1 herzie", "Held by 12 herzies". */
export const heldByLabel = (n: number) =>
  `Held by ${n.toLocaleString("en-US")} herzie${n === 1 ? "" : "s"}`;

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
