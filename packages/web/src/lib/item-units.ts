import {
  bestUnitOf,
  type ItemUnit,
  MAX_ITEM_UPGRADE_LEVEL,
  normalizeEquipped,
  normalizeUnits,
  pickPlainestUnitIds,
} from "@herzies/shared";
import type { createAdminClient } from "@/lib/supabase-admin";

type Admin = ReturnType<typeof createAdminClient>;

/** What every inventory RPC returns under `state` (item_state, 00079). */
export interface ItemState {
  units: unknown;
  inventory: Record<string, number>;
  equipped: unknown;
  itemUpgrades: Record<string, number>;
  currency: number;
}

/**
 * The response fields every inventory mutation returns: the units themselves,
 * plus the id-keyed views (`inventory`, `equipped`, `itemUpgrades`) that
 * clients built before per-copy identity still read. Spread it into the JSON.
 */
export function itemResponse(state: ItemState) {
  return {
    units: normalizeUnits(state.units),
    inventory: state.inventory ?? {},
    equipped: normalizeEquipped(state.equipped),
    itemUpgrades: state.itemUpgrades ?? {},
  };
}

/** The player's copies, oldest first (the order item_units_json returns). */
export async function loadUnits(
  admin: Admin,
  userId: string,
): Promise<ItemUnit[]> {
  const { data } = await admin.rpc("item_units_json", { p_user_id: userId });
  return normalizeUnits(data);
}

// ---------------------------------------------------------------------------
// Older clients speak in item ids ("sell 2 cd", "equip boombox", "upgrade
// boombox") because that was all there was to say. These pick the specific
// copies such a request most plausibly means, so those clients keep working
// while newer ones name copies directly. Each is a pure function over the
// player's units; none touches the database.
// ---------------------------------------------------------------------------

/** "Sell/offer N of this item": the plainest copies first — unworn before worn,
 * then lowest level, then oldest — so a spare goes before one you've invested
 * in or are wearing. Null if the player doesn't own that many. The same rule
 * the desktop uses wherever it only knows an item id. */
export const unitsForLegacyCount = pickPlainestUnitIds;

/** "Equip this item": the copy already worn if there is one (so a repeat is
 * reported as already-equipped, as it always was), else the best copy, which
 * keeps the stats an older client expects from the level it saw. */
export const unitForLegacyEquip = bestUnitOf;

/** "Unequip this item": whichever copy is worn. */
export function unitForLegacyUnequip(
  units: readonly ItemUnit[],
  itemId: string,
): ItemUnit | undefined {
  return units.find((u) => u.itemId === itemId && u.equippedSlot !== null);
}

/** "Upgrade this item": the copy furthest along that can still take a level, so
 * repeated upgrades from an older client concentrate on one card the way the
 * old per-item level did; the worn copy wins a tie. */
export function unitForLegacyUpgrade(
  units: readonly ItemUnit[],
  itemId: string,
): ItemUnit | undefined {
  return units
    .filter(
      (u) => u.itemId === itemId && u.upgradeLevel < MAX_ITEM_UPGRADE_LEVEL,
    )
    .reduce<ItemUnit | undefined>((best, u) => {
      if (!best) return u;
      if (u.upgradeLevel !== best.upgradeLevel) {
        return u.upgradeLevel > best.upgradeLevel ? u : best;
      }
      return best.equippedSlot === null && u.equippedSlot !== null ? u : best;
    }, undefined);
}

// ---------------------------------------------------------------------------
// Trade offers.
//
// An offer is a list of specific copies, snapshotted with what the other side
// needs to judge it ("+3 Box of Boom") so they don't need a live look into
// your inventory. `items` is the same offer counted by item id, kept because
// clients that predate copies only know how to read that shape.
// ---------------------------------------------------------------------------

export interface OfferedUnit {
  unitId: string;
  itemId: string;
  upgradeLevel: number;
}

export interface StoredOffer {
  units: OfferedUnit[];
  items: Record<string, number>;
  currency: number;
}

export function countByItem(
  units: readonly { itemId: string }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of units) out[u.itemId] = (out[u.itemId] ?? 0) + 1;
  return out;
}

/** Whether two offers give the same copies for the same coins. Compares copies
 * by id, not by item: swapping your +0 Box of Boom for your +3 one is a
 * different offer and must reset the other side's accept. A stored offer from
 * before copies existed has no `units`, so it never equals a new one. */
export function sameOffer(
  a: Partial<StoredOffer> | null | undefined,
  b: StoredOffer,
): boolean {
  if (!a || !Array.isArray(a.units)) return false;
  if (a.currency !== b.currency) return false;
  if (a.units.length !== b.units.length) return false;
  const have = new Set(a.units.map((u) => u.unitId));
  return b.units.every((u) => have.has(u.unitId));
}
