import { getItem, type ItemUnit } from "@herzies/shared";

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
