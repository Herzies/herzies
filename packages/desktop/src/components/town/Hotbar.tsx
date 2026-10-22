import {
  CONSUMABLE_COOLDOWN_MS,
  describeSkill,
  getItem,
  ItemTypeIcon,
  type ItemUnit,
  SKILL_DEFS,
  type SkillId,
} from "@herzies/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { DeckSlotPicker, type PickerOption } from "../DeckSlotPicker";
import { Tooltip } from "../Tooltip";
import { queueMySkill, skills, useSkills } from "./combat/skills";
import { eat, useLastEat } from "./eat";
import {
  assignHotbar,
  clearHotbar,
  HOTBAR_KEYS,
  type HotbarKey,
  SKILL_SLOT,
  useHotbar,
} from "./hotbarSlots";

/** A skill's letters on its hotbar slot. */
const SKILL_ABBR: Record<SkillId, string> = {
  backspin: "BS",
  "soothing-drones": "SD",
  cymbrella: "CB",
};

/**
 * The four slots, on keys 1-4: each holds a consumable (its icon and how
 * many are left in the bank) or your class skill (its letters, greyed while
 * it cools down, with the seconds left). Empty or eaten-out slots are
 * dimmed; hovering one names it (a skill, with what it does). Click a
 * filled slot to use it; click an empty one (or right-click any) to pick
 * what goes there — your skill or a consumable, the list the deck's empty
 * slots open. The bank's right-click menu fills them too.
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
  useSkills();
  const mine = skills.mine;
  const lastEat = useLastEat();
  // The skill's cooldown runs off the frame clock, not renders: a shade
  // over the slot, shrinking from the top, and the seconds left.
  const skillShade = useRef<HTMLSpanElement>(null);
  const skillSecs = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const id = skills.mine?.id;
      if (id && skillShade.current && skillSecs.current) {
        const left = Math.max(0, skills.readyAt - performance.now());
        const f = Math.min(1, left / SKILL_DEFS[id].cooldownMs);
        skillShade.current.style.height = `${f * 100}%`;
        skillSecs.current.textContent =
          f > 0 ? String(Math.ceil(left / 1000)) : "";
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);
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
        if (slots[key] === SKILL_SLOT) {
          const def = mine ? SKILL_DEFS[mine.id] : null;
          return (
            <Tooltip
              key={key}
              label={
                mine && def ? (
                  <div className="w-[180px] whitespace-normal">
                    <div className="font-bold">
                      {def.name}{" "}
                      <span className="font-normal text-text-dim">
                        Lv. {mine.level}
                      </span>
                    </div>
                    <div className="text-text-dim">
                      {describeSkill(mine.id, mine.level)}
                    </div>
                  </div>
                ) : (
                  "Your class skill — pick a class first"
                )
              }
            >
              <button
                type="button"
                aria-label={def ? `${key}: ${def.name}` : `${key}: class skill`}
                onClick={(e) => {
                  if (mine) queueMySkill();
                  else openPicker(key, e);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openPicker(key, e);
                }}
                className={cn(
                  "pointer-events-auto relative flex size-9 cursor-pointer items-center justify-center overflow-hidden rounded border border-white/20 bg-black/55 p-0",
                  !mine && "opacity-45 hover:opacity-80",
                )}
              >
                {/* Q casts it too, wherever it sits. */}
                <span className="absolute top-0 left-0.5 text-[9px] leading-none text-white/70">
                  {key}/Q
                </span>
                <span className="text-[11px] font-bold text-white">
                  {mine ? SKILL_ABBR[mine.id] : "—"}
                </span>
                {/* Cooling down: a shade over it, and the seconds left. */}
                <span
                  ref={skillShade}
                  aria-hidden
                  className="absolute inset-x-0 top-0 bg-black/60"
                  style={{ height: 0 }}
                />
                <span
                  ref={skillSecs}
                  // Where an item slot shows its count.
                  className="absolute right-0.5 bottom-0 text-[9px] leading-none text-white tabular-nums"
                />
              </button>
            </Tooltip>
          );
        }
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
          extra={
            mine && slots[picker.key] !== SKILL_SLOT ? (
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-1.5 border-none bg-transparent px-3 py-1 text-left text-text hover:bg-white/5"
                onClick={() => {
                  assignHotbar(picker.key, SKILL_SLOT);
                  setPicker(null);
                }}
              >
                <span className="w-4 shrink-0 text-center text-[9px] font-bold text-cyan">
                  {SKILL_ABBR[mine.id]}
                </span>
                <span className="truncate">{SKILL_DEFS[mine.id].name}</span>
              </button>
            ) : undefined
          }
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
