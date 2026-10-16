import {
  CONSUMABLE_COOLDOWN_MS,
  getItem,
  ItemTypeIcon,
  type ItemUnit,
} from "@herzies/shared";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { DeckSlotPicker, type PickerOption } from "../DeckSlotPicker";
import { Tooltip } from "../Tooltip";
import { eat, useLastEat } from "./eat";
import {
  assignHotbar,
  clearHotbar,
  HOTBAR_KEYS,
  type HotbarKey,
  useHotbar,
} from "./hotbarSlots";

/**
 * The three consumable slots, on keys 2, 3 and 4: each shows its key, the
 * item, and how many are left in the bank. Empty or eaten-out slots are
 * dimmed; hovering one names it. Click a filled slot to eat from it; click
 * an empty one (or right-click any) to pick what goes there — the same
 * list the deck's empty slots open. The bank's right-click menu fills them
 * too.
 */
export function Hotbar({
  units,
  className,
}: {
  units: readonly ItemUnit[];
  /** Where it sits: absolute-positioning classes. */
  className?: string;
}) {
  const slots = useHotbar();
  const lastEat = useLastEat();
  // Re-render once the cooldown's over, to drop the flash.
  const [, setTick] = useState(0);
  useEffect(() => {
    const left = lastEat + CONSUMABLE_COOLDOWN_MS - performance.now();
    if (left <= 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), left);
    return () => clearTimeout(t);
  }, [lastEat]);
  const cooling = performance.now() - lastEat < CONSUMABLE_COOLDOWN_MS;
  const [picker, setPicker] = useState<{
    key: HotbarKey;
    x: number;
    y: number;
  } | null>(null);

  // One row per consumable in the bank, whole stacks (the hotbar eats from
  // the stack, not a particular copy).
  const options = useMemo(() => {
    const counts = new Map<string, PickerOption>();
    for (const u of units) {
      if (u.equippedSlot || !getItem(u.itemId)?.consumable) continue;
      const row = counts.get(u.itemId);
      if (row) row.count = (row.count ?? 0) + 1;
      else
        counts.set(u.itemId, {
          itemId: u.itemId,
          unitId: u.id,
          upgradeLevel: 0,
          count: 1,
        });
    }
    return [...counts.values()].sort((a, b) =>
      (getItem(a.itemId)?.name ?? "").localeCompare(
        getItem(b.itemId)?.name ?? "",
      ),
    );
  }, [units]);

  const openPicker = (key: HotbarKey, e: React.MouseEvent) =>
    setPicker({ key, x: e.clientX, y: e.clientY });

  return (
    <div className={cn("absolute z-30 flex gap-1", className)}>
      {HOTBAR_KEYS.map((key) => {
        const itemId = slots[key];
        const item = itemId ? getItem(itemId) : undefined;
        const count = itemId
          ? units.filter((u) => u.itemId === itemId && !u.equippedSlot).length
          : 0;
        return (
          <Tooltip
            key={key}
            label={item ? `${item.name} (${count})` : "Empty — click to fill"}
          >
            <button
              type="button"
              aria-label={
                item
                  ? `${key}: eat ${item.name} (${count} left)`
                  : `${key}: empty`
              }
              onClick={(e) => {
                // An eaten-out slot opens the list too: nothing to eat there.
                if (itemId && count > 0) void eat(itemId);
                else openPicker(key, e);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openPicker(key, e);
              }}
              className={cn(
                "pointer-events-auto relative flex size-9 cursor-pointer items-center justify-center rounded border border-white/20 bg-black/55 p-0",
                (!item || count === 0) && "opacity-45 hover:opacity-80",
                cooling && item && "border-white/50",
              )}
            >
              <span className="absolute top-0 left-0.5 text-[9px] leading-none text-white/70">
                {key}
              </span>
              {item ? <ItemTypeIcon item={item} className="size-6" /> : null}
              {item ? (
                <span className="absolute right-0.5 bottom-0 text-[9px] leading-none text-white tabular-nums">
                  {count}
                </span>
              ) : null}
              {cooling && item ? (
                <span
                  aria-hidden
                  className="absolute inset-0 rounded bg-white/15"
                />
              ) : null}
            </button>
          </Tooltip>
        );
      })}
      {picker && (
        <DeckSlotPicker
          x={picker.x}
          y={picker.y}
          slotLabel={`Hotbar ${picker.key}`}
          options={options}
          onPick={({ itemId }) => {
            assignHotbar(picker.key, itemId);
            setPicker(null);
          }}
          onClear={
            slots[picker.key]
              ? () => {
                  clearHotbar(picker.key);
                  setPicker(null);
                }
              : undefined
          }
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
