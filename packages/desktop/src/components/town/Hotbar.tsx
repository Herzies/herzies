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
import {
  instrumentNeeded,
  mySkillAt,
  queueSkill,
  skills,
  useSkills,
} from "./combat/skills";
import { canHeal, toggleStance, useStance } from "./combat/stance";
import { eat, useLastEat } from "./eat";
import {
  assignHotbar,
  clearHotbar,
  HOTBAR_KEYS,
  type HotbarKey,
  MAX_CLASS_SKILLS,
  skillOfSlot,
  skillSlot,
  useHotbar,
} from "./hotbarSlots";

/** A skill's letters on its hotbar slot. */
const SKILL_ABBR: Record<SkillId, string> = {
  backspin: "BS",
  "soothing-drones": "SD",
  cymbrella: "CB",
  resurrect: "RZ",
  taunt: "TA",
  haste: "HS",
};

/**
 * A Bard's lute stance, left of the hotbar: attacking (⚔) or healing (✚),
 * R or a click to switch. Only for a Bard with a lute.
 */
function StanceSlot() {
  useSkills();
  const heal = useStance();
  if (skills.instrument !== "lute") return null;
  const armed = canHeal();
  return (
    <Tooltip
      label={
        <div className="w-[190px] whitespace-normal">
          <div className="font-bold">
            Lute: {heal ? "healing" : "attacking"}
          </div>
          <div className="text-text-dim">
            {heal
              ? "Your attack heals the ally under your crosshair. R to attack."
              : "R to heal: your attack heals the ally under your crosshair instead."}
          </div>
          {!armed && (
            <div className="mt-1 text-red-300">Equip "Lute" to heal.</div>
          )}
        </div>
      }
    >
      <button
        type="button"
        aria-label={
          heal ? "Lute stance: healing (R)" : "Lute stance: attacking (R)"
        }
        aria-pressed={heal}
        onClick={() => toggleStance()}
        className={cn(
          "pointer-events-auto relative flex size-9 cursor-pointer items-center justify-center rounded border bg-black/55 p-0",
          heal ? "border-[#7ee2a8]/80" : "border-white/20",
          !armed && "opacity-45 grayscale",
        )}
      >
        <span className="absolute top-0 left-0.5 text-[9px] leading-none text-white/70">
          R
        </span>
        <span
          className={cn(
            "text-[15px] font-bold leading-none",
            heal ? "text-[#7ee2a8]" : "text-white",
          )}
        >
          {heal ? "✚" : "⚔"}
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * One of your class skills on the hotbar: its letters, greyed from the top
 * while it cools down with the seconds left, and a hint of what it does.
 * The first is on Q too, wherever it sits.
 */
function SkillSlot({
  hotkey,
  n,
  onPick,
}: {
  hotkey: HotbarKey;
  /** Which of your skills (1-based, the class's order). */
  n: number;
  onPick: (e: React.MouseEvent) => void;
}) {
  useSkills();
  const mine = mySkillAt(n);
  const def = mine ? SKILL_DEFS[mine.id] : null;
  // The cooldown runs off the frame clock, not renders.
  const shade = useRef<HTMLSpanElement>(null);
  const secs = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const s = mySkillAt(n);
      if (shade.current && secs.current) {
        if (!s) {
          shade.current.style.height = "0";
          if (secs.current.textContent) secs.current.textContent = "";
        } else {
          const left = Math.max(
            0,
            (skills.readyAt.get(s.id) ?? 0) - performance.now(),
          );
          const f = Math.min(1, left / SKILL_DEFS[s.id].cooldownMs);
          shade.current.style.height = `${f * 100}%`;
          // Text only when it changes (a write replaces the node).
          const text = f > 0 ? String(Math.ceil(left / 1000)) : "";
          if (secs.current.textContent !== text)
            secs.current.textContent = text;
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [n]);
  return (
    <Tooltip
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
            {!skills.armed && (
              <div className="mt-1 text-red-300">
                {instrumentNeeded(mine.id)}
              </div>
            )}
          </div>
        ) : n === 1 ? (
          "Your class skill — pick a class first"
        ) : n === 2 ? (
          "Your class's second skill (Bards and Percussionists have one)"
        ) : (
          "Your class's third skill (Bards learn Haste at level 15)"
        )
      }
    >
      <button
        type="button"
        aria-label={def ? `${hotkey}: ${def.name}` : `${hotkey}: class skill`}
        onClick={(e) => {
          if (mine) queueSkill(n);
          else onPick(e);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onPick(e);
        }}
        className={cn(
          "pointer-events-auto relative flex size-9 cursor-pointer items-center justify-center overflow-hidden rounded border border-white/20 bg-black/55 p-0",
          !mine && "opacity-45 hover:opacity-80",
          mine && !skills.armed && "opacity-45 grayscale",
        )}
      >
        <span className="absolute top-0 left-0.5 text-[9px] leading-none text-white/70">
          {n === 1 ? `${hotkey}/Q` : hotkey}
        </span>
        <span className="text-[11px] font-bold text-white">
          {mine ? SKILL_ABBR[mine.id] : "—"}
        </span>
        <span
          ref={shade}
          aria-hidden
          className="absolute inset-x-0 top-0 bg-black/60"
          style={{ height: 0 }}
        />
        <span
          ref={secs}
          className="absolute right-0.5 bottom-0 text-[9px] leading-none text-white tabular-nums"
        />
      </button>
    </Tooltip>
  );
}

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
      <StanceSlot />
      {HOTBAR_KEYS.map((key) => {
        const n = skillOfSlot(slots[key]);
        if (n !== null)
          return (
            <SkillSlot
              key={key}
              hotkey={key}
              n={n}
              onPick={(e) => openPicker(key, e)}
            />
          );
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
            skills.list.length ? (
              <div>
                {skills.list.slice(0, MAX_CLASS_SKILLS).map((s, i) =>
                  slots[picker.key] === skillSlot(i + 1) ? null : (
                    <button
                      key={s.id}
                      type="button"
                      className="flex w-full cursor-pointer items-center gap-1.5 border-none bg-transparent px-3 py-1 text-left text-text hover:bg-white/5"
                      onClick={() => {
                        assignHotbar(picker.key, skillSlot(i + 1));
                        setPicker(null);
                      }}
                    >
                      <span className="w-4 shrink-0 text-center text-[9px] font-bold text-cyan">
                        {SKILL_ABBR[s.id]}
                      </span>
                      <span className="truncate">{SKILL_DEFS[s.id].name}</span>
                    </button>
                  ),
                )}
              </div>
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
