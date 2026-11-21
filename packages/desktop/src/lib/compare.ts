import {
  getHerzieStatsFromUnits,
  getItem,
  type HerzieStats,
  type ItemUnit,
  STAT_KEYS,
  type StatKey,
  type UnitSlot,
} from "@herzies/shared";

/**
 * Comparing a bag copy with what's worn (Shift over a bag tile): which worn
 * copy it would replace, and what wearing it does to the herzie's stats.
 */

export type Comparison = {
  /** The slot it would go in. */
  slot: UnitSlot;
  /** The copy worn there now, or null when the slot is empty. */
  worn: ItemUnit | null;
  /** The herzie's stats now, and with this copy worn instead (set bonuses
   * and dice levels counted, as the Stats window does). */
  now: HerzieStats;
  then: HerzieStats;
  /** The stats that change, in the usual order. */
  changes: StatKey[];
};

/**
 * What wearing bag copy `unitId` instead of what's worn would change, or null
 * when there's nothing to compare: it isn't wearable, or it's a modifier (six
 * of those are worn side by side; none is replaced). Ground goes on the left
 * side unless that's filled and the right isn't, as an equip would.
 */
export function compareWithWorn(
  unitId: string,
  units: readonly ItemUnit[],
): Comparison | null {
  const unit = units.find((u) => u.id === unitId);
  const slotOf = unit ? getItem(unit.itemId)?.equipSlot : undefined;
  if (!unit || !slotOf || slotOf === "modifier") return null;
  const wornIn = (s: UnitSlot) => units.find((u) => u.equippedSlot === s);
  let slot: UnitSlot;
  if (slotOf === "ground") {
    slot =
      wornIn("ground_left") && !wornIn("ground_right")
        ? "ground_right"
        : "ground_left";
  } else slot = slotOf;
  const worn = wornIn(slot) ?? null;
  const swapped = units.map((u) =>
    u.id === unit.id
      ? { ...u, equippedSlot: slot }
      : u.id === worn?.id
        ? { ...u, equippedSlot: null }
        : u,
  );
  const now = getHerzieStatsFromUnits(units);
  const then = getHerzieStatsFromUnits(swapped);
  return {
    slot,
    worn,
    now,
    then,
    changes: STAT_KEYS.filter((k) => then[k] !== now[k]),
  };
}
