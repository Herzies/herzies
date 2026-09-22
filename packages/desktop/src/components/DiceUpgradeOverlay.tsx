import {
  getItem,
  MAX_ITEM_UPGRADE_LEVEL,
  RARITY_COLORS,
  STAT_KEYS,
  STAT_LABELS,
} from "@herzies/shared";
import { useEffect } from "react";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
import { List } from "./List";

/** Full-screen overlay opened by clicking a dice item in the Inventory grid
 * — lists owned, statted, not-yet-maxed cards to apply it to. Mirrors
 * ItemInspectOverlay's modal chrome (not DeckSlotPicker's small anchored
 * popover): there's no "slot" to anchor to here, and each row needs room
 * for a stat-delta preview line. */
export function DiceUpgradeOverlay({
  diceItemId,
  inventory,
  itemUpgrades,
  onPick,
  onClose,
}: {
  diceItemId: string;
  inventory: Record<string, number> | null;
  itemUpgrades: Record<string, number>;
  onPick: (targetItemId: string) => void;
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

  const eligible = Object.entries(inventory ?? {})
    .filter(([id, qty]) => {
      if (qty <= 0 || id === diceItemId) return false;
      const def = getItem(id);
      if (!def?.stats || Object.keys(def.stats).length === 0) return false;
      return (itemUpgrades[id] ?? 0) < MAX_ITEM_UPGRADE_LEVEL;
    })
    .sort(([a], [b]) =>
      (getItem(a)?.name ?? a).localeCompare(getItem(b)?.name ?? b),
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
            {eligible.map(([id]) => {
              const def = getItem(id)!;
              const level = itemUpgrades[id] ?? 0;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onPick(id)}
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
