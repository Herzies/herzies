import {
  type BitCost,
  canAfford,
  getItem,
  type HerzieClass,
  ItemTypeIcon,
  type ItemUnit,
  isInBag,
  isWildsBit,
  RARITY_COLORS,
  TUNABLE_INSTRUMENTS,
  TUNING_MAX_LEVEL,
  tuningCost,
  WILDS_BITS,
  WILDS_RECIPES,
  type WildsRecipe,
} from "@herzies/shared";
import { useState } from "react";
import { notify } from "../lib/notices";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import ItemInspectOverlay, {
  INSPECT_ORIGIN_ATTR,
  inspectOrigin,
} from "./ItemInspectOverlay";
import { List } from "./List";
import { TabButton } from "./TabButton";
import { Tooltip } from "./Tooltip";

/** A card to open Inspect on: which, at what tuning, and (for one shown
 * with its icon) the INSPECT_ORIGIN_ATTR key the card grows out of. */
type Inspecting = { itemId: string; level: number; origin?: string };
type OnInspect = (target: Inspecting) => void;

/** The window's two tabs. */
type Tab = "craft" | "tune";
const TABS: { id: Tab; name: string }[] = [
  { id: "craft", name: "Craft" },
  { id: "tune", name: "Tune" },
];

/**
 * The Crafting Station's window, opened at any Crafting Station's bench (the
 * Wilds' safe camp has one; see town/wilds/craftingSpot.ts), in two tabs:
 * Craft (first) makes any class's Wilds instrument out of that class's own
 * and bits, yours first; Tune tunes any instrument you have with bits.
 * Titled like any visitor's window: the name, the tabs, then each thing
 * to do with its cost and its one button; your bits at the foot, as a
 * stall shows your coins.
 *
 * Every card named here — what a recipe makes and what from, each bit in a
 * cost, the instruments to tune, your bits — opens Inspect on a click, as a
 * stall's rows do (ItemRow): the card grows out of the icon where there is
 * one, and Escape or the backdrop puts it back. The Craft and Tune buttons
 * sit beside them, never inside, so a click on a card only ever inspects.
 *
 * The web API crafts and tunes (it checks everything again and takes the
 * bits); the counts here are only so the buttons say what you can afford.
 * The new bag comes back with the answer, and the app's state with it.
 */
export function CraftingPanel({
  units,
  herzieClass,
  onLog,
}: {
  /** Every copy you own. */
  units: readonly ItemUnit[];
  /** Your class: its recipe comes first (any class may make any). */
  herzieClass: HerzieClass | null;
  onLog?: (message: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("craft");
  /** The recipe or unit an answer is on its way for. */
  const [busy, setBusy] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<Inspecting | null>(null);

  const bits: Record<string, number> = {};
  for (const u of units)
    if (isInBag(u)) bits[u.itemId] = (bits[u.itemId] ?? 0) + 1;

  const classOf = (r: WildsRecipe) => getItem(r.base)?.requiredClass ?? null;
  const recipes = [...WILDS_RECIPES].sort(
    (a, b) =>
      Number(classOf(b) === herzieClass) - Number(classOf(a) === herzieClass),
  );
  // Every instrument you have, worn or in the bag, best first.
  const tunable = units
    .filter((u) => TUNABLE_INSTRUMENTS.includes(u.itemId))
    .sort(
      (a, b) =>
        Number(b.equippedSlot !== null) - Number(a.equippedSlot !== null) ||
        nameOf(a.itemId).localeCompare(nameOf(b.itemId)) ||
        b.upgradeLevel - a.upgradeLevel,
    );

  const craft = async (r: WildsRecipe) => {
    setBusy(r.id);
    try {
      await herzies.craftWildsInstrument(r.id);
      const line = `Made "${nameOf(r.id)}" at the Crafting Station`;
      notify(line, { kind: "success" });
      onLog?.(line);
    } catch (e: unknown) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const tune = async (u: ItemUnit) => {
    setBusy(u.id);
    try {
      const r = await herzies.tuneInstrument(u.id);
      const line = `Tuned "${nameOf(u.itemId)}" to +${r.newLevel}`;
      notify(line, { kind: "success" });
      onLog?.(line);
    } catch (e: unknown) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="text-center text-[16px] font-bold text-[#d9d4cc]">
        The Crafting Station
      </div>

      <div className="flex shrink-0 gap-1 border-b border-white/15 text-ui">
        {TABS.map((t) => (
          <TabButton
            key={t.id}
            active={t.id === tab}
            onClick={() => setTab(t.id)}
          >
            {t.name}
          </TabButton>
        ))}
      </div>

      <List className="min-h-0 flex-1">
        {tab === "craft" &&
          recipes.map((r) => {
            const base = units.find((u) => u.itemId === r.base && isInBag(u));
            const worn = !base && units.some((u) => u.itemId === r.base);
            const ok = !!base && canAfford(bits, r.bits);
            // The base's tuning is kept, so the card shows what you'd get.
            const level = base?.upgradeLevel ?? 0;
            return (
              <Row
                key={r.id}
                itemId={r.id}
                level={level}
                origin={`craft:${r.id}`}
                onInspect={setInspecting}
                sub={
                  <>
                    from{" "}
                    <CardLink
                      itemId={r.base}
                      level={level}
                      onInspect={setInspecting}
                    >
                      {nameOf(r.base)}
                    </CardLink>
                    {level > 0 ? ` +${level} (kept)` : ""}
                    {base ? null : (
                      <span className="text-red">
                        {worn ? " · take it off first" : " · you need one"}
                      </span>
                    )}
                  </>
                }
                cost={r.bits}
                have={bits}
                action={
                  <button
                    type="button"
                    className={cn("btn", ok ? "text-cyan" : "text-text-dim")}
                    disabled={!ok || busy !== null}
                    onClick={() => craft(r)}
                  >
                    {busy === r.id ? "Making..." : "Craft"}
                  </button>
                }
              />
            );
          })}

        {tab === "tune" &&
          (tunable.length === 0 ? (
            <div className="px-2 py-1.5 text-ui-sm text-text-dim">
              No instruments to tune.
            </div>
          ) : (
            tunable.map((u) => {
              const cost = tuningCost(u.upgradeLevel);
              const ok = cost !== null && canAfford(bits, cost);
              return (
                <Row
                  key={u.id}
                  itemId={u.itemId}
                  level={u.upgradeLevel}
                  origin={`tune:${u.id}`}
                  onInspect={setInspecting}
                  sub={
                    cost === null
                      ? `Fully tuned at +${TUNING_MAX_LEVEL}: Power Dice from here`
                      : `+${u.upgradeLevel} → +${u.upgradeLevel + 1}${
                          u.equippedSlot !== null ? " · worn" : ""
                        }`
                  }
                  cost={cost}
                  have={bits}
                  action={
                    cost === null ? null : (
                      <button
                        type="button"
                        className={cn(
                          "btn",
                          ok ? "text-cyan" : "text-text-dim",
                        )}
                        disabled={!ok || busy !== null}
                        onClick={() => tune(u)}
                      >
                        {busy === u.id ? "Tuning..." : "Tune"}
                      </button>
                    )
                  }
                />
              );
            })
          ))}
      </List>

      {/* Your bits, bottom right. */}
      <div className="flex justify-end gap-3 border-t border-white/15 pt-1.5">
        {WILDS_BITS.map((id) => {
          const def = getItem(id);
          const origin = `bit:${id}`;
          return (
            <Tooltip key={id} label={def?.name ?? id}>
              <button
                type="button"
                aria-label={`Inspect ${def?.name ?? id}`}
                onClick={() => setInspecting({ itemId: id, level: 0, origin })}
                {...{ [INSPECT_ORIGIN_ATTR]: origin }}
                className="group flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-ui"
              >
                {def ? (
                  <ItemTypeIcon item={def} className="h-4 w-4 shrink-0" />
                ) : null}
                <span
                  className="group-hover:underline"
                  style={def ? { color: RARITY_COLORS[def.rarity] } : {}}
                >
                  {bits[id] ?? 0}
                </span>
              </button>
            </Tooltip>
          );
        })}
      </div>

      {inspecting && getItem(inspecting.itemId) ? (
        <ItemInspectOverlay
          itemId={inspecting.itemId}
          level={inspecting.level}
          origin={inspecting.origin && inspectOrigin(inspecting.origin)}
          onClose={() => setInspecting(null)}
          meta={
            isWildsBit(inspecting.itemId)
              ? `${bits[inspecting.itemId] ?? 0} owned`
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

function nameOf(id: string): string {
  return getItem(id)?.name ?? id;
}

/** A card named in a line of text (a recipe's base, a bit in a cost): a
 * click opens Inspect on it. No icon here, so the card just appears. */
function CardLink({
  itemId,
  level = 0,
  onInspect,
  children,
}: {
  itemId: string;
  level?: number;
  onInspect: OnInspect;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title="Inspect card"
      onClick={() => onInspect({ itemId, level })}
      className="cursor-pointer border-none bg-transparent p-0 text-inherit hover:underline"
    >
      {children}
    </button>
  );
}

/** One thing to make or tune: what (its icon and name open Inspect, the card
 * growing out of the icon), a line under it, what it costs (each bit as
 * have/need, red where you're short, its name opening Inspect too) and its
 * button. */
function Row({
  itemId,
  level = 0,
  origin,
  onInspect,
  sub,
  cost,
  have,
  action,
}: {
  itemId: string;
  level?: number;
  /** Its INSPECT_ORIGIN_ATTR key, unique in the panel. */
  origin: string;
  onInspect: OnInspect;
  sub: React.ReactNode;
  cost: BitCost | null;
  have: Record<string, number>;
  action: React.ReactNode;
}) {
  const def = getItem(itemId);
  const inspect = () => onInspect({ itemId, level, origin });
  return (
    <div className="flex items-center gap-2 border-t border-white/10 px-2 py-1.5 first:border-t-0">
      {def ? (
        // The name below is the same button for keyboards and readers.
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={inspect}
          {...{ [INSPECT_ORIGIN_ATTR]: origin }}
          className="shrink-0 cursor-pointer border-none bg-transparent p-0"
        >
          <ItemTypeIcon item={def} className="h-6 w-6" />
        </button>
      ) : null}
      <div className="min-w-0 flex-1">
        <button
          type="button"
          title="Inspect card"
          onClick={inspect}
          className="block max-w-full cursor-pointer truncate border-none bg-transparent p-0 text-left text-ui hover:underline"
          style={def ? { color: RARITY_COLORS[def.rarity] } : {}}
        >
          {def?.name ?? itemId}
          {level > 0 ? ` +${level}` : ""}
        </button>
        <div className="truncate text-ui-sm text-text-dim">{sub}</div>
        {cost ? (
          <div className="flex flex-wrap gap-x-2 text-ui-sm">
            {Object.entries(cost).map(([bit, need]) => {
              const n = have[bit] ?? 0;
              return (
                <span
                  key={bit}
                  className={n >= (need ?? 0) ? "text-text" : "text-red"}
                >
                  <CardLink itemId={bit} onInspect={onInspect}>
                    {nameOf(bit)}
                  </CardLink>{" "}
                  {n}/{need}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  );
}
