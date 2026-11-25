import {
  getHerzieStatsFromUnits,
  getItem,
  type HerzieClass,
  type ItemUnit,
  type LoadoutIndex,
  type LoadoutState,
  RARITY_COLORS,
  STAT_KEYS,
} from "@herzies/shared";
import {
  LOADOUT_COOLDOWN_MS,
  loadoutCooldownLeft,
  useLoadoutCooldownSecs,
} from "../lib/loadoutState";
import { predictLoadoutSwitch } from "../lib/loadouts";
import { cn } from "../lib/utils";
import { SwapIcon } from "./icons/SwapIcon";
import { StatChanges } from "./StatChanges";
import { HoverPreview, Tooltip } from "./Tooltip";
import { useCooldownShade } from "./town/cooldownShade";
import { HotbarGhost } from "./town/HotbarGhost";
import { useDragToHotbar } from "./town/hotbarDrop";
import { loadoutSlot } from "./town/hotbarSlots";

/** The switching cooldown over the other tab: greyed from the top. */
function CooldownShade() {
  return useCooldownShade(
    (now) => ({ ms: loadoutCooldownLeft(now), span: LOADOUT_COOLDOWN_MS }),
    { seconds: false },
  );
}

/**
 * The Deck's two loadouts, as tabs: the one worn filled, the other outlined.
 * Clicking the other one switches (see useLoadoutSwitch); hovering it shows
 * what it would put on and what that does to the stats. Left of them, the
 * swap (two arrows) switches to whichever isn't on. For LOADOUT_COOLDOWN_MS
 * after a switch (here or on a hotbar key) the other tab and the swap are
 * off, greyed from the top with the seconds left beside them. The swap and
 * either tab can be dragged onto a hotbar slot, to do the same with a key.
 */
export function LoadoutTabs({
  loadouts,
  active,
  switching,
  blocked,
  units,
  stage,
  herzieClass,
  onSwitch,
  className,
}: {
  loadouts: LoadoutState | null | undefined;
  /** The loadout shown as worn (the one being switched to, while it is). */
  active: LoadoutIndex;
  switching: boolean;
  /** Why switching is off right now, or null. */
  blocked: string | null;
  units: readonly ItemUnit[];
  stage: number;
  herzieClass: HerzieClass | null;
  onSwitch: (to: LoadoutIndex) => void;
  className?: string;
}) {
  const drag = useDragToHotbar();
  const cooldown = useLoadoutCooldownSecs();
  const other = active === 1 ? 2 : 1;
  // Not `disabled`, here or on the tabs: a disabled button takes no pointer
  // events, and it can still be dragged to the hotbar.
  const swapOff = !!blocked || switching || cooldown > 0;
  return (
    <div className={cn("relative flex items-center gap-1", className)}>
      <Tooltip
        label={
          blocked ??
          (cooldown > 0
            ? `Loadouts switch again in ${cooldown}s`
            : `Swap to loadout ${other} — drag onto the hotbar to give it a key`)
        }
      >
        <button
          type="button"
          aria-label={`Swap to loadout ${other}`}
          aria-disabled={swapOff}
          onPointerDown={(e) => drag.start(loadoutSlot("swap"), e)}
          onClick={() => {
            if (drag.endedDrag() || swapOff) return;
            onSwitch(other);
          }}
          className={cn(
            "relative flex h-4 w-5 touch-none items-center justify-center overflow-hidden border border-white/20 bg-transparent text-text-dim transition-colors duration-150",
            swapOff
              ? "cursor-default opacity-40"
              : "cursor-pointer hover:border-white/50 hover:text-text",
          )}
        >
          <SwapIcon className="size-3" />
          <CooldownShade />
        </button>
      </Tooltip>
      <div
        role="tablist"
        aria-label="Loadouts"
        className="flex items-center gap-1"
      >
        {([1, 2] as const).map((n) => {
          const on = n === active;
          const off = !on && swapOff;
          const tab = (
            <button
              type="button"
              role="tab"
              aria-selected={on}
              aria-disabled={off}
              onPointerDown={(e) => drag.start(loadoutSlot(n), e)}
              onClick={() => {
                if (drag.endedDrag() || on || off) return;
                onSwitch(n);
              }}
              className={cn(
                "relative flex h-4 w-5 touch-none items-center justify-center overflow-hidden border text-ui-sm leading-none font-bold transition-colors duration-150",
                on
                  ? "cursor-default border-cyan bg-cyan/20 text-cyan"
                  : off
                    ? "cursor-default border-white/20 bg-transparent text-text-dim opacity-40"
                    : "cursor-pointer border-white/20 bg-transparent text-text-dim hover:border-white/50 hover:text-text",
              )}
            >
              {n}
              {on ? null : <CooldownShade />}
            </button>
          );
          if (on)
            return (
              <Tooltip
                key={n}
                label={`Loadout ${n} — drag onto the hotbar to give it a key`}
              >
                {tab}
              </Tooltip>
            );
          if (blocked || cooldown > 0) {
            return (
              <Tooltip
                key={n}
                label={blocked ?? `Loadouts switch again in ${cooldown}s`}
              >
                {tab}
              </Tooltip>
            );
          }
          // Anchored under the tab rather than chasing the cursor: it's a
          // card's worth, and the tabs sit at the top of their window.
          return (
            <HoverPreview
              key={n}
              alwaysAbove={false}
              estWidth={200}
              estHeight={170}
              content={
                <div className="w-[200px] rounded border border-white/15 bg-bg-panel px-2 py-1 text-ui-sm text-text">
                  <LoadoutPreview
                    n={n}
                    loadouts={loadouts}
                    units={units}
                    stage={stage}
                    herzieClass={herzieClass}
                  />
                </div>
              }
            >
              {tab}
            </HoverPreview>
          );
        })}
      </div>
      {/* Out of the row's flow, just left of the swap: the buttons stay put
          as it comes and goes. Left, not right: in the small window the row
          is flush with the window's right edge. */}
      {cooldown > 0 ? (
        <span className="absolute top-1/2 right-full mr-1.5 -translate-y-1/2">
          <Tooltip label={`Loadouts switch again in ${cooldown}s`}>
            <span className="text-ui-sm text-text-dim tabular-nums">
              {cooldown}s
            </span>
          </Tooltip>
        </span>
      ) : null}
      <HotbarGhost ghost={drag.ghost} />
    </div>
  );
}

/** The other loadout, on hover: its pieces (a gone one greyed out) and the
 * stats that would change. */
function LoadoutPreview({
  n,
  loadouts,
  units,
  stage,
  herzieClass,
}: {
  n: LoadoutIndex;
  loadouts: LoadoutState | null | undefined;
  units: readonly ItemUnit[];
  stage: number;
  herzieClass: HerzieClass | null;
}) {
  if (!loadouts) return null;
  // Not made yet: it starts empty, so switching to it leaves the herzie bare.
  const inactive = loadouts.inactive ?? [];
  const owned = new Set(units.map((u) => u.id));
  const now = getHerzieStatsFromUnits(units);
  const then = getHerzieStatsFromUnits(
    predictLoadoutSwitch(units, loadouts, stage, herzieClass).units,
  );
  const changes = STAT_KEYS.filter((k) => then[k] !== now[k]);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-bold text-text">Loadout {n}</span>
      {inactive.length === 0 ? (
        <span className="text-text-dim">Nothing worn</span>
      ) : (
        inactive.map((piece) => {
          const def = getItem(piece.itemId);
          const gone = !(piece.unitId && owned.has(piece.unitId));
          return (
            <span
              // One worn copy per item: the item names the row.
              key={`${piece.slot}:${piece.itemId}`}
              className="truncate"
            >
              <span
                className={cn(gone && "line-through opacity-50")}
                style={{
                  color: def ? RARITY_COLORS[def.rarity] : undefined,
                }}
              >
                {def?.name ?? piece.itemId}
              </span>
              {gone && <span className="ml-1 text-text-dim">not owned</span>}
            </span>
          );
        })
      )}
      <StatChanges now={now} then={then} changes={changes} />
    </div>
  );
}
