import {
  bestUnitOf,
  type ItemUnit,
  type LoadoutState,
  MAX_ITEM_UPGRADE_LEVEL,
  normalizeEquipped,
  normalizeUnits,
  pickPlainestUnitIds,
  requiredDiceForLevel,
} from "@herzies/shared";
import type { createAdminClient } from "@/lib/supabase-admin";

type Admin = ReturnType<typeof createAdminClient>;

/** What every inventory RPC returns under `state` (item_state, 00079;
 * `loadouts` since 00152). */
export interface ItemState {
  units: unknown;
  inventory: Record<string, number>;
  equipped: unknown;
  itemUpgrades: Record<string, number>;
  currency: number;
  loadouts?: LoadoutState | null;
}

/**
 * The response fields every inventory mutation returns: the units themselves,
 * plus the id-keyed views (`inventory`, `equipped`, `itemUpgrades`) that
 * clients built before per-copy identity still read, and the loadouts (the
 * Deck's 1 | 2 tabs, whose inactive set can lose a copy to any mutation).
 * Spread it into the JSON.
 */
export function itemResponse(state: ItemState) {
  return {
    units: normalizeUnits(state.units),
    inventory: state.inventory ?? {},
    equipped: normalizeEquipped(state.equipped),
    itemUpgrades: state.itemUpgrades ?? {},
    ...(state.loadouts ? { loadouts: state.loadouts } : {}),
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

/** The loadouts (loadout_state_json, 00152), or undefined when they couldn't
 * be read: a client keeps what it has rather than resetting its tabs. */
export async function loadLoadouts(
  admin: Admin,
  userId: string,
): Promise<LoadoutState | undefined> {
  const { data, error } = await admin.rpc("loadout_state_json", {
    p_user: userId,
  });
  return error || !data ? undefined : (data as LoadoutState);
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
 * in or are wearing; copies the other loadout holds are never picked. Null if
 * the player doesn't have that many to give. The same rule the desktop uses
 * wherever it only knows an item id. */
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

/** "Upgrade this item": the copy furthest along that this die can still take
 * a level, so repeated upgrades from an older client concentrate on one card
 * the way the old per-item level did; the worn copy wins a tie. Copies past
 * this die's band, and copies the other loadout holds (apply_item_upgrade
 * refuses those), are skipped rather than picked and refused. */
export function unitForLegacyUpgrade(
  units: readonly ItemUnit[],
  itemId: string,
  diceItemId: string,
): ItemUnit | undefined {
  return units
    .filter(
      (u) =>
        u.itemId === itemId &&
        u.heldBy === undefined &&
        u.upgradeLevel < MAX_ITEM_UPGRADE_LEVEL &&
        requiredDiceForLevel(u.upgradeLevel) === diceItemId,
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
