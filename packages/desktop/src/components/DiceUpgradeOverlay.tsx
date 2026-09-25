import {
  getItem,
  type ItemUnit,
  MAX_ITEM_UPGRADE_LEVEL,
  RARITY_COLORS,
  STAT_KEYS,
  STAT_LABELS,
} from "@herzies/shared";
import { useEffect } from "react";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
import { List } from "./List";

/** One row: a card that can take a level. Copies of the same card at the same
 * level, both worn or both not, are interchangeable and share a row; copies at
 * different levels don't, which is the point of picking one. */
interface Target {
  /** The copy this row upgrades. */
  unitId: string;
  itemId: string;
  level: number;
  worn: boolean;
  /** How many interchangeable copies the row stands for. */
  count: number;
}

/** Full-screen overlay opened by clicking a dice item in the Inventory grid
 * — lists owned, statted, not-yet-maxed cards to apply it to. Mirrors
 * ItemInspectOverlay's modal chrome (not DeckSlotPicker's small anchored
 * popover): there's no "slot" to anchor to here, and each row needs room
 * for a stat-delta preview line.
 *
 * Picks a specific copy: upgrading one Box of Boom leaves the other alone, so
 * two of them at different levels have to be told apart here. */
export function DiceUpgradeOverlay({
  diceItemId,
  units,
  onPick,
  onClose,
}: {
  diceItemId: string;
  units: readonly ItemUnit[];
  onPick: (targetUnitId: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const dice = getItem(diceItemId);
  if (!dice) return null;

  const targets = new Map<string, Target>();
  for (const u of units) {
    if (u.itemId === diceItemId) continue;
    const def = getItem(u.itemId);
    if (!def?.stats || Object.keys(def.stats).length === 0) continue;
    if (u.upgradeLevel >= MAX_ITEM_UPGRADE_LEVEL) continue;
    const worn = u.equippedSlot !== null;
    const key = `${u.itemId}:${u.upgradeLevel}:${worn}`;
    const existing = targets.get(key);
    if (existing) existing.count += 1;
    else {
      targets.set(key, {
        unitId: u.id,
        itemId: u.itemId,
        level: u.upgradeLevel,
        worn,
        count: 1,
      });
    }
  }
  const eligible = [...targets.values()].sort(
    (a, b) =>
      (getItem(a.itemId)?.name ?? a.itemId).localeCompare(
        getItem(b.itemId)?.name ?? b.itemId,
      ) ||
      b.level - a.level ||
      Number(b.worn) - Number(a.worn),
  );

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-80 max-w-full border border-border bg-bg-panel p-3 shadow-xl shadow-black/50"
      >
        <div className="mb-2 text-center text-sm font-bold">
          Upgrade a card with "{dice.name}"
        </div>
        {eligible.length === 0 ? (
          <div className="py-4 text-center text-ui-sm text-text-dim">
            No cards to upgrade
          </div>
        ) : (
          <List className="max-h-80">
            {eligible.map((target) => {
              const def = getItem(target.itemId)!;
              const { level } = target;
              return (
                <button
                  key={`${target.itemId}:${level}:${target.worn}`}
                  type="button"
                  onClick={() => onPick(target.unitId)}
                  className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-2 py-1.5 text-left hover:bg-white/5"
                >
                  <ItemTypeIcon item={def} className="h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div
                      className="truncate text-ui"
                      style={{ color: RARITY_COLORS[def.rarity] }}
                    >
                      {def.name}
                      {level > 0 ? ` +${level}` : ""}
                      {target.worn ? " (placed)" : ""}
                      {target.count > 1 ? ` x${target.count}` : ""}
                    </div>
                    <div className="text-ui-sm text-text-dim">
                      {STAT_KEYS.filter((k) => def.stats?.[k] !== undefined)
                        .map(
                          (k) =>
                            `${STAT_LABELS[k]}: +${(def.stats?.[k] ?? 0) + level}`,
                        )
                        .join(" · ")}{" "}
                      ({level}/{MAX_ITEM_UPGRADE_LEVEL} used)
                    </div>
                  </div>
                </button>
              );
            })}
          </List>
        )}
      </div>
    </div>
  );
}
