import {
  formatStat,
  type HerzieStats,
  STAT_KEYS,
  STAT_LABELS,
} from "@herzies/shared";
import { useEffect } from "react";
import { cn } from "../lib/utils";
import { OVERLAY_PANEL } from "./DeckOverlay";
import { refreshVitals, useVitals } from "./town/vitals";

/** The herzie's stats, beside it on the Herzie view. While a card is held over
 * the herzie, `preview` is what the stats would become if it were dropped, and
 * each stat that would move shows its new value instead. */
export function StatsPanel({
  stats,
  preview,
}: {
  stats: HerzieStats;
  preview?: HerzieStats | null;
}) {
  // Max health, which comes with the level. The Town may not have loaded it
  // yet, so ask when the panel opens.
  const maxHp = useVitals()?.maxHp;
  useEffect(() => {
    refreshVitals();
  }, []);
  return (
    <div
      className={cn("min-w-[100px] text-[9px] leading-tight", OVERLAY_PANEL)}
    >
      {maxHp ? (
        <div className="flex justify-between gap-2">
          <span className="text-text-dim">Max HP</span>
          <span className="text-text-dim">{maxHp}</span>
        </div>
      ) : null}
      {/* Every stat, even at 0: the deck is where you build them, so crit
          chance and damage are listed before anything gives them. */}
      {STAT_KEYS.map((key) => {
        const delta = preview ? preview[key] - stats[key] : 0;
        return (
          <div key={key} className="flex justify-between gap-2">
            <span className="text-text-dim">{STAT_LABELS[key]}</span>
            {/* While a card is held, the value it would become, in place of
                the current one: green if it goes up, red if it goes down.
                Otherwise the label's own colour — a bright one read as a
                bigger number. */}
            <span
              className={
                delta > 0
                  ? "text-green"
                  : delta < 0
                    ? "text-red"
                    : "text-text-dim"
              }
            >
              {formatStat(
                key,
                delta !== 0 && preview ? preview[key] : stats[key],
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
