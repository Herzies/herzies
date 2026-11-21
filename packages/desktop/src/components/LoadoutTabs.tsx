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
import { predictLoadoutSwitch } from "../lib/loadouts";
import { cn } from "../lib/utils";
import { StatChanges } from "./StatChanges";
import { HoverPreview, Tooltip } from "./Tooltip";

/**
 * The Deck's two loadouts, as tabs: the one worn filled, the other outlined.
 * Clicking the other one switches (see useLoadoutSwitch); hovering it shows
 * what it would put on and what that does to the stats.
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
  return (
    <div
      role="tablist"
      aria-label="Loadouts"
      className={cn("flex items-center gap-1", className)}
    >
      {([1, 2] as const).map((n) => {
        const on = n === active;
        const tab = (
          <button
            type="button"
            role="tab"
            aria-selected={on}
            disabled={!on && (!!blocked || switching)}
            onClick={() => onSwitch(n)}
            className={cn(
              "flex h-4 w-5 items-center justify-center border text-ui-sm leading-none font-bold transition-colors duration-150",
              on
                ? "cursor-default border-cyan bg-cyan/20 text-cyan"
                : "cursor-pointer border-white/20 bg-transparent text-text-dim hover:border-white/50 hover:text-text disabled:cursor-default disabled:opacity-40 disabled:hover:border-white/20 disabled:hover:text-text-dim",
            )}
          >
            {n}
          </button>
        );
        if (on) return <span key={n}>{tab}</span>;
        if (blocked) {
          return (
            <Tooltip key={n} label={blocked}>
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
