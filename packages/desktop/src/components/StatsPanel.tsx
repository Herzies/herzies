import { type HerzieStats, STAT_KEYS, STAT_LABELS } from "@herzies/shared";
import { cn } from "../lib/utils";
import { OVERLAY_PANEL, OVERLAY_TITLE } from "./DeckOverlay";

/** The herzie's stats, beside it on the Herzie view. While a card is held over
 * the herzie, `preview` is what the stats would become if it were dropped, and
 * each stat that would move shows by how much. */
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
      <div className={OVERLAY_TITLE}>Stats</div>
      {STAT_KEYS.map((key) => {
        const delta = preview ? preview[key] - stats[key] : 0;
        return (
          <div key={key} className="flex justify-between gap-2">
            <span className="text-text-dim">{STAT_LABELS[key]}</span>
            <span className={stats[key] > 0 ? "text-cyan" : "text-text-dim"}>
              {stats[key]}
              {delta !== 0 && (
                <span className={delta > 0 ? "text-green" : "text-red"}>
                  {" "}
                  {delta > 0 ? `+${delta}` : delta}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
