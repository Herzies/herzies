import { type HerzieStats, STAT_KEYS, STAT_LABELS } from "@herzies/shared";
import { cn } from "../lib/utils";
import { HEADER_ICON_HIT } from "./headerIconHit";
import { Tooltip } from "./Tooltip";

/** Wide enough that the name/value columns don't sit on top of each other. */
const CARD_WIDTH = 150;

/**
 * Header icon that reveals the herzie's stats on hover, next to the
 * modifiers icon and working the same way: the totals come from the equipped
 * items, so the list stays off the home screen itself. Lit up while any stat
 * is above zero.
 */
export function StatsButton({ stats }: { stats: HerzieStats }) {
  const hasStats = STAT_KEYS.some((key) => stats[key] > 0);

  const card = (
    <div className="text-[10px]" style={{ minWidth: CARD_WIDTH }}>
      <div className="mb-0.5 text-ui-sm font-bold text-text">Stats</div>
      {STAT_KEYS.map((key) => (
        <div key={key} className="flex justify-between gap-2">
          <span className="text-text-dim">{STAT_LABELS[key]}</span>
          <span className={stats[key] > 0 ? "text-cyan" : "text-text-dim"}>
            {stats[key]}
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <Tooltip label={card}>
      <button
        type="button"
        className={cn(
          HEADER_ICON_HIT,
          "flex h-5 w-5 cursor-default items-center justify-center rounded-lg border-none bg-transparent p-0",
          hasStats ? "text-cyan" : "text-text-dim hover:text-text",
        )}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-label="Stats"
          role="img"
        >
          <path d="M18 20V10" />
          <path d="M12 20V4" />
          <path d="M6 20v-6" />
        </svg>
      </button>
    </Tooltip>
  );
}
