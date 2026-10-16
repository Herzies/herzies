import {
  CONSUMABLE_COOLDOWN_MS,
  getItem,
  ItemTypeIcon,
  type ItemUnit,
} from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { eat, useLastEat } from "./eat";
import { clearHotbar, HOTBAR_KEYS, useHotbar } from "./hotbarSlots";

/**
 * The three consumable slots, on keys 2, 3 and 4: each shows its key, the
 * item, and how many are left in the bank. Empty or eaten-out slots are
 * dimmed. Click a slot to eat from it too; right-click empties it. Slots
 * are filled from the bank's right-click menu.
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

  // Nothing assigned yet: no bar.
  if (HOTBAR_KEYS.every((k) => slots[k] === null)) return null;

  return (
    <div className={cn("absolute z-30 flex gap-1", className)}>
      {HOTBAR_KEYS.map((key) => {
        const itemId = slots[key];
        const item = itemId ? getItem(itemId) : undefined;
        const count = itemId
          ? units.filter((u) => u.itemId === itemId && !u.equippedSlot).length
          : 0;
        return (
          <button
            key={key}
            type="button"
            aria-label={
              item
                ? `${key}: eat ${item.name} (${count} left)`
                : `${key}: empty`
            }
            disabled={!item || count === 0}
            onClick={() => {
              if (itemId) void eat(itemId);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              clearHotbar(key);
            }}
            className={cn(
              "pointer-events-auto relative flex size-9 cursor-pointer items-center justify-center rounded border border-white/20 bg-black/55 p-0 disabled:cursor-default",
              (!item || count === 0) && "opacity-45",
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
        );
      })}
    </div>
  );
}
