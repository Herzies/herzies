import { type HerzieStats, STAT_KEYS, STAT_LABELS } from "@herzies/shared";
import { cn } from "../lib/utils";
import { OVERLAY_PANEL } from "./DeckOverlay";

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
  return (
    <div
      className={cn("min-w-[100px] text-[9px] leading-tight", OVERLAY_PANEL)}
    >
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
              {delta !== 0 && preview ? preview[key] : stats[key]}
            </span>
          </div>
        );
      })}
    </div>
  );
}
