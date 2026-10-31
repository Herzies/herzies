import { getItem, ITEMS, type ItemUnit, type Rarity } from "@herzies/shared";

/** Copies of one item at one upgrade level: one row on the Sell tab. */
export interface ListableCopies {
  itemId: string;
  upgradeLevel: number;
  unitIds: string[];
}

/** The copies Plutus will take: unworn, and not class gear (bound to its
 * herzie, as for trades). The server refuses the rest anyway; this keeps them
 * off the Sell tab. Alike copies share a row (a stack of sweets is one line,
 * not thirty), grouped by name with the most upgraded first. */
export function listableCopies(units: readonly ItemUnit[]): ListableCopies[] {
  const rows = new Map<string, ListableCopies>();
  for (const u of units) {
    const def = getItem(u.itemId);
    if (!def || u.equippedSlot || def.requiredClass) continue;
    const key = `${u.itemId}:${u.upgradeLevel}`;
    const row = rows.get(key);
    if (row) row.unitIds.push(u.id);
    else {
      rows.set(key, {
        itemId: u.itemId,
        upgradeLevel: u.upgradeLevel,
        unitIds: [u.id],
      });
    }
  }
  const name = (r: ListableCopies) => getItem(r.itemId)?.name ?? r.itemId;
  return [...rows.values()].sort(
    (a, b) => name(a).localeCompare(name(b)) || b.upgradeLevel - a.upgradeLevel,
  );
}

/** The Collect button's label, or null when nothing's waiting. */
export function collectLabel(coins: number, items: number): string | null {
  const parts = [
    coins > 0 ? `${coins} ${coins === 1 ? "coin" : "coins"}` : null,
    items > 0 ? `${items} ${items === 1 ? "item" : "items"}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `Collect ${parts.join(" / ")}` : null;
}

const RARITIES = new Set<string>([
  "common",
  "uncommon",
  "rare",
  "legendary",
  "mythic",
] satisfies Rarity[]);

/** The items a search on the Browse tab means, for the board to narrow to.
 * Every word must fit: a rarity ("rare") picks that rarity; any other word
 * matches the name, the id, or the slot it's worn in ("head", "back"). Class
 * gear is left out, since it can't be listed. Nothing typed matches nothing. */
export function matchMarketItems(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return ITEMS.filter(
    (item) =>
      !item.requiredClass &&
      words.every((w) =>
        RARITIES.has(w)
          ? item.rarity === w
          : item.name.toLowerCase().includes(w) ||
            item.id.includes(w) ||
            (item.equipSlot?.split("_").includes(w) ?? false),
      ),
  ).map((item) => item.id);
}
