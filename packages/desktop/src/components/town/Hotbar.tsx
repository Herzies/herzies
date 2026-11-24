import {
  CONSUMABLE_COOLDOWN_MS,
  describeSkill,
  getItem,
  ItemTypeIcon,
  type ItemUnit,
  isInBag,
  SKILL_DEFS,
} from "@herzies/shared";
import { useEffect, useMemo, useState } from "react";
import {
  LOADOUT_COOLDOWN_MS,
  loadoutCooldownLeft,
  useLoadouts,
} from "../../lib/loadoutState";
import { cn } from "../../lib/utils";
import { DeckSlotPicker, type PickerOption } from "../DeckSlotPicker";
import { SwapIcon } from "../icons/SwapIcon";
import { Tooltip } from "../Tooltip";
import {
  instrumentNeeded,
  mySkillAt,
  skills,
  useSkills,
} from "./combat/skills";
import { canHeal, toggleStance, useStance } from "./combat/stance";
import { useCooldownShade } from "./cooldownShade";
import { EmoteBar } from "./EmoteBar";
import { useLastEat } from "./eat";
import { HotbarGhost } from "./HotbarGhost";
import { HOTBAR_SLOT_ATTR, useDragToHotbar, useHotbarDrag } from "./hotbarDrop";
import { slotKeysLabel, useHotbarKeys } from "./hotbarKeys";
import {
  assignHotbar,
  clearHotbar,
  type LoadoutTarget,
  loadoutOfSlot,
  loadoutSlot,
  MAX_CLASS_SKILLS,
  skillOfSlot,
  skillSlot,
  useHotbar,
} from "./hotbarSlots";
import { pressHotbarSlot } from "./hotbarUse";
import { SKILL_ABBR, skillTextColour } from "./skillBadge";

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

/** A slot's box: the drop ring while something's carried over it. */
function slotClass(over: boolean) {
  return cn(
    "pointer-events-auto relative flex size-9 cursor-pointer touch-none items-center justify-center overflow-hidden rounded border border-white/20 bg-black/55 p-0",
    over && "ring-2 ring-cyan",
  );
}

/** A slot's keys, top left. */
function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <span className="absolute top-0 left-0.5 text-[9px] leading-none text-white/70">
      {children}
    </span>
  );
}

/** What every slot gets: its place, its keys ("1/Q"), whether something's
 * carried over it, the slot's picker, and the bar's drag (a filled slot can
 * be dragged to another, or off the bar to empty it). */
interface SlotProps {
  i: number;
  keyLabel: string | null;
  over: boolean;
  onPick: (e: React.MouseEvent) => void;
  drag: ReturnType<typeof useDragToHotbar>;
}

/** The handlers every filled slot's button has: a press can become a drag
 * (whose trailing click does nothing), a right-click opens the picker. */
function slotHandlers(
  { i, onPick, drag }: SlotProps,
  value: string,
  onClick: (e: React.MouseEvent) => void,
) {
  return {
    [HOTBAR_SLOT_ATTR]: i,
    onPointerDown: (e: React.PointerEvent) => drag.start(value, e, { from: i }),
    onClick: (e: React.MouseEvent) => {
      if (!drag.endedDrag()) onClick(e);
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      onPick(e);
    },
  };
}

/**
 * One of your class skills on the hotbar: its letters in its class's
 * colour, greyed from the top while it cools down with the seconds left, and
 * a hint of what it does.
 */
function SkillSlot({
  n,
  ...props
}: SlotProps & {
  /** Which of your skills (1-based, the class's order). */
  n: number;
}) {
  const { i, keyLabel, over, onPick } = props;
  useSkills();
  const mine = mySkillAt(n);
  const def = mine ? SKILL_DEFS[mine.id] : null;
  const shade = useCooldownShade((now) => {
    const s = mySkillAt(n);
    return s
      ? {
          ms: Math.max(0, (skills.readyAt.get(s.id) ?? 0) - now),
          span: skills.spanMs.get(s.id) ?? SKILL_DEFS[s.id].cooldownMs,
        }
      : { ms: 0, span: 1 };
  });
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
        {...slotHandlers(props, skillSlot(n), (e) => {
          if (mine) pressHotbarSlot(i);
          else onPick(e);
        })}
        aria-label={
          def
            ? `${keyLabel ?? ""}: ${def.name}`
            : `${keyLabel ?? ""}: class skill`
        }
        className={cn(
          slotClass(over),
          !mine && "opacity-45 hover:opacity-80",
          mine && !skills.armed && "opacity-45 grayscale",
        )}
      >
        {keyLabel ? <KeyCap>{keyLabel}</KeyCap> : null}
        <span
          className={cn(
            "text-[11px] font-bold",
            mine ? skillTextColour(mine.id) : "text-white",
          )}
        >
          {mine ? SKILL_ABBR[mine.id] : "—"}
        </span>
        {shade}
      </button>
    </Tooltip>
  );
}

/** A loadout on the hotbar: "L1" or "L2", outlined while it's the one worn,
 * or the swap's two arrows (to whichever isn't on); greyed from the top
 * while switching cools down (LOADOUT_COOLDOWN_MS). */
function LoadoutSlot({ n, ...props }: SlotProps & { n: LoadoutTarget }) {
  const { i, keyLabel, over } = props;
  const loadouts = useLoadouts();
  const on = loadouts?.active === n;
  const shade = useCooldownShade((now) => ({
    ms: loadoutCooldownLeft(now),
    span: LOADOUT_COOLDOWN_MS,
  }));
  const swap = n === "swap";
  const label = swap
    ? `Swap loadouts${loadouts ? ` (to ${loadouts.active === 1 ? 2 : 1})` : ""}`
    : on
      ? `Loadout ${n} — worn now`
      : `Switch to loadout ${n}`;
  return (
    <Tooltip label={label}>
      <button
        type="button"
        {...slotHandlers(props, loadoutSlot(n), () => pressHotbarSlot(i))}
        aria-label={`${keyLabel ?? ""}: ${swap ? "swap loadouts" : `loadout ${n}`}`}
        aria-pressed={swap ? undefined : on}
        className={cn(slotClass(over), on && "border-cyan/80")}
      >
        {keyLabel ? <KeyCap>{keyLabel}</KeyCap> : null}
        {swap ? (
          <SwapIcon className="size-5 text-cyan" />
        ) : (
          <span
            className={cn(
              "text-[11px] font-bold",
              on ? "text-cyan" : "text-white",
            )}
          >
            L{n}
          </span>
        )}
        {shade}
      </button>
    </Tooltip>
  );
}

/** An item on the hotbar: a consumable (how many are left in the bank,
 * flashed while eating cools down) or a card to wear (outlined while worn);
 * or nothing. */
function ItemSlot({
  itemId,
  units,
  cooling,
  ...props
}: SlotProps & {
  itemId: string | null;
  units: readonly ItemUnit[];
  cooling: boolean;
}) {
  const { i, keyLabel, over, onPick } = props;
  const item = itemId ? getItem(itemId) : undefined;
  const card = !!item && !item.consumable;
  const count = itemId
    ? units.filter((u) => u.itemId === itemId && (card || isInBag(u))).length
    : 0;
  const worn =
    card && units.some((u) => u.itemId === itemId && u.equippedSlot !== null);
  const label = !item
    ? "Empty — click to fill, or drag a card or a skill here"
    : count === 0
      ? `${item.name} (none left)`
      : card
        ? `${item.name} — ${worn ? "worn: press to take it off" : "press to put it on"}`
        : `${item.name} (${count})`;
  // A slot with nothing to use opens the list too.
  const use = (e: React.MouseEvent) => {
    if (item && count > 0) pressHotbarSlot(i);
    else onPick(e);
  };
  return (
    <Tooltip label={label}>
      <button
        type="button"
        {...(itemId
          ? slotHandlers(props, itemId, use)
          : {
              [HOTBAR_SLOT_ATTR]: i,
              onClick: use,
              onContextMenu: (e: React.MouseEvent) => {
                e.preventDefault();
                onPick(e);
              },
            })}
        aria-label={
          item
            ? card
              ? `${keyLabel ?? ""}: ${worn ? "take off" : "put on"} ${item.name}`
              : `${keyLabel ?? ""}: eat ${item.name} (${count} left)`
            : `${keyLabel ?? ""}: empty`
        }
        aria-pressed={card ? worn : undefined}
        className={cn(
          slotClass(over),
          (!item || count === 0) && "opacity-45 hover:opacity-80",
          !card && cooling && item && "border-white/50",
          worn && "border-cyan/80",
        )}
      >
        {keyLabel ? <KeyCap>{keyLabel}</KeyCap> : null}
        {item ? <ItemTypeIcon item={item} className="size-6" /> : null}
        {item && !card ? (
          <span className="absolute right-0.5 bottom-0 text-[9px] leading-none text-white tabular-nums">
            {count}
          </span>
        ) : null}
        {!card && cooling && item ? (
          <span aria-hidden className="absolute inset-0 rounded bg-white/15" />
        ) : null}
      </button>
    </Tooltip>
  );
}

/**
 * The eight slots, each on its keys (1-8, and Q on the first, unless set
 * otherwise in Settings: hotbarKeys.ts). Each holds a consumable (its icon
 * and how many are left in the bank), a card to wear (outlined while worn:
 * pressing puts it on or takes it off, in the loadout you're on), a loadout
 * to switch to, or one of your class skills (its letters, greyed while it
 * cools down, with the seconds left). Empty or eaten-out slots are dimmed;
 * hovering one names it. Click a filled slot to use it; click an empty one
 * (or right-click any) to pick what goes there — a skill, a loadout or a
 * consumable, in a list over the bar. The bank's right-click menu fills them
 * too, and a card, a loadout tab or a skill's badge dragged onto one lands
 * there. A slot dragged onto another swaps with it; dragged off the bar, it
 * empties.
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
  const keys = useHotbarKeys();
  const loadouts = useLoadouts();
  const carried = useHotbarDrag();
  const drag = useDragToHotbar();
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
    i: number;
    x: number;
    y: number;
  } | null>(null);

  // One row per consumable in the bank, whole stacks (the hotbar eats from
  // the stack, not a particular copy).
  const options = useMemo(() => {
    const counts = new Map<string, PickerOption>();
    for (const u of units) {
      if (!isInBag(u) || !getItem(u.itemId)?.consumable) continue;
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

  // Opens over the slot: under the bar there's only the chat.
  const openPicker = (i: number, e: React.MouseEvent) =>
    setPicker({
      i,
      x: e.clientX,
      y: e.currentTarget.getBoundingClientRect().top,
    });

  /** The picker's rows besides the consumables: your skills, then the
   * loadouts and the swap, less what's in the slot already. */
  const pickRow = (
    key: string,
    abbr: React.ReactNode,
    colour: string,
    name: string,
    value: string,
  ) =>
    picker && slots[picker.i] === value ? null : (
      <button
        key={key}
        type="button"
        className="flex w-full cursor-pointer items-center gap-1.5 border-none bg-transparent px-3 py-1 text-left text-text hover:bg-white/5"
        onClick={() => {
          if (picker) assignHotbar(picker.i, value);
          setPicker(null);
        }}
      >
        <span
          className={cn(
            "w-4 shrink-0 text-center text-[9px] font-bold",
            colour,
          )}
        >
          {abbr}
        </span>
        <span className="truncate">{name}</span>
      </button>
    );
  const extraRows = [
    ...skills.list
      .slice(0, MAX_CLASS_SKILLS)
      .map((s, i) =>
        pickRow(
          s.id,
          SKILL_ABBR[s.id],
          skillTextColour(s.id),
          SKILL_DEFS[s.id].name,
          skillSlot(i + 1),
        ),
      ),
    ...(loadouts
      ? ([1, 2, "swap"] as const).map((n) =>
          pickRow(
            `loadout:${n}`,
            n === "swap" ? <SwapIcon className="mx-auto size-3.5" /> : `L${n}`,
            "text-cyan",
            n === "swap" ? "Swap loadouts" : `Loadout ${n}`,
            loadoutSlot(n),
          ),
        )
      : []),
  ].filter(Boolean);

  return (
    <div
      className={cn(
        "absolute flex gap-1",
        // Over open windows while something's carried to it (hotbarDrop).
        carried ? "z-[61]" : "z-30",
        className,
      )}
    >
      {/* Held Alt: the emotes, just over the slots. */}
      <EmoteBar className="bottom-full inset-x-0 mb-1.5" />
      <StanceSlot />
      {slots.map((value, i) => {
        const props: SlotProps = {
          i,
          keyLabel: slotKeysLabel(keys[i]),
          over: carried?.over === i,
          onPick: (e) => openPicker(i, e),
          drag,
        };
        const n = skillOfSlot(value);
        // biome-ignore lint/suspicious/noArrayIndexKey: a slot is its place on the bar
        if (n !== null) return <SkillSlot key={i} n={n} {...props} />;
        const loadout = loadoutOfSlot(value);
        if (loadout !== null)
          // biome-ignore lint/suspicious/noArrayIndexKey: a slot is its place on the bar
          return <LoadoutSlot key={i} n={loadout} {...props} />;
        return (
          <ItemSlot
            // biome-ignore lint/suspicious/noArrayIndexKey: a slot is its place on the bar
            key={i}
            itemId={value}
            units={units}
            cooling={cooling}
            {...props}
          />
        );
      })}
      <HotbarGhost ghost={drag.ghost} />
      {picker && (
        <DeckSlotPicker
          x={picker.x}
          y={picker.y}
          above
          slotLabel={`Hotbar ${slotKeysLabel(keys[picker.i]) ?? picker.i + 1}`}
          options={options}
          extra={extraRows.length ? <div>{extraRows}</div> : undefined}
          onPick={({ itemId }) => {
            assignHotbar(picker.i, itemId);
            setPicker(null);
          }}
          onClear={
            slots[picker.i]
              ? () => {
                  clearHotbar(picker.i);
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
