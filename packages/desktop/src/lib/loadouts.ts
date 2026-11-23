import {
  applyEquip,
  getItem,
  groundSideOf,
  growsBagPastCapacity,
  type HerzieClass,
  type ItemUnit,
  type LoadoutIndex,
  type LoadoutRefusal,
  type LoadoutState,
} from "@herzies/shared";

/** What a switch to the other loadout is expected to do: the copies as
 * they'll be, the pieces that won't make it (by item id) as the server's
 * report would name them, and whether the switch is refused because the bag
 * can't take the refused pieces. */
export interface LoadoutPrediction {
  units: ItemUnit[];
  missing: string[];
  refused: string[];
  bagFull: boolean;
}

/** A copy with its holder set (or cleared: absent, as the server sends it). */
function heldBy(unit: ItemUnit, by: LoadoutIndex | undefined): ItemUnit {
  const { heldBy: _, ...rest } = unit;
  return by === undefined ? rest : { ...rest, heldBy: by };
}

/**
 * A loadout switch as switch_loadout (00152) does it, for the UI to show at
 * once. Nothing moves through the bag: everything worn comes off and is held
 * by the loadout being left, then each piece the other loadout holds goes on
 * under the rules of equipping by hand (`applyEquip`). A piece whose copy is
 * gone is reported missing; one the herzie can't wear (stage, class, the
 * modifier cap) goes to the bag and is reported refused, and if the bag
 * can't take those (`capacity`, omitted to skip the check) the whole switch
 * is refused.
 *
 * `inactive` null: the other loadout hasn't been made yet, so it's empty and
 * the switch leaves the herzie bare.
 */
export function predictLoadoutSwitch(
  units: readonly ItemUnit[],
  loadouts: LoadoutState,
  stage: number,
  herzieClass: HerzieClass | null,
  capacity = Number.POSITIVE_INFINITY,
): LoadoutPrediction {
  const from = loadouts.active;
  const pieces = loadouts.inactive ?? [];
  // The target's rows are deleted as it's worn; the worn pieces get rows.
  const target = new Set(pieces.map((p) => p.unitId));
  let next: ItemUnit[] = units.map((u) => {
    const holder =
      u.equippedSlot !== null ? from : target.has(u.id) ? undefined : u.heldBy;
    const off = u.equippedSlot === null ? u : { ...u, equippedSlot: null };
    return off.heldBy === holder ? off : heldBy(off, holder);
  });
  const missing: string[] = [];
  const refused: string[] = [];
  for (const piece of pieces) {
    const unit = next.find((u) => u.id === piece.unitId);
    if (!unit) {
      missing.push(piece.itemId);
      continue;
    }
    const item = getItem(unit.itemId);
    const outcome = applyEquip(
      next,
      unit.id,
      "equip",
      item?.equipSlot,
      piece.slot === "modifier" ? undefined : groundSideOf(piece.slot),
      {
        minStage: item?.minStage,
        stage,
        requiredClass: item?.requiredClass,
        herzieClass,
      },
    );
    if (!outcome.ok) {
      refused.push(piece.itemId);
      continue;
    }
    next = outcome.units;
  }
  // switch_loadout's rule: refused only if the refused pieces grow the bag
  // past what it holds.
  const bagFull = growsBagPastCapacity(units, next, capacity);
  return { units: next, missing, refused, bagFull };
}

/** Names for a list of item ids, quoted and counted: `"Wizard Hat"`,
 * `"Wizard Hat" and "Cape"`, `"Wizard Hat" and 2 more`. */
export function itemList(itemIds: readonly string[]): string {
  const names = itemIds.map((id) => `"${getItem(id)?.name ?? id}"`);
  if (names.length <= 2) return names.join(" and ");
  return `${names[0]} and ${names.length - 1} more`;
}

/** What a switch's report says to the player: nothing when it all went on. */
export function switchReportLine(report: {
  missing: readonly string[];
  refused: readonly string[];
}): string | null {
  const parts: string[] = [];
  if (report.missing.length > 0) {
    parts.push(`${itemList(report.missing)} no longer owned`);
  }
  if (report.refused.length > 0) {
    parts.push(`${itemList(report.refused)} can't be worn`);
  }
  return parts.length > 0 ? `Left off: ${parts.join("; ")}` : null;
}

/** A refused switch, in the player's words. */
export function loadoutRefusalText(reason: string): string {
  const known: Record<LoadoutRefusal, string> = {
    same: "That loadout is already on",
    "too-soon": "Switching too fast",
    invalid: "There's no such loadout",
    "bag-full": "Your bag is full: make room first.",
  };
  return reason in known
    ? known[reason as LoadoutRefusal]
    : `Couldn't switch loadouts: ${reason}`;
}
