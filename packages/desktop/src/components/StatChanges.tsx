import {
  formatStat,
  type HerzieStats,
  STAT_LABELS,
  type StatKey,
} from "@herzies/shared";

/** What a change of gear does to the herzie's stats, one per line: the stat,
 * then "now → then", green where it rises and red where it falls. Ruled off
 * from what's above it. Nothing when `changes` is empty. */
export function StatChanges({
  now,
  then,
  changes,
}: {
  now: HerzieStats;
  then: HerzieStats;
  changes: readonly StatKey[];
}) {
  if (changes.length === 0) return null;
  return (
    <div className="mt-0.5 flex flex-col border-t border-white/15 pt-0.5 text-ui-sm">
      {changes.map((k) => (
        <span key={k} className="flex justify-between gap-3">
          <span className="text-text-dim">{STAT_LABELS[k]}</span>
          <span className="whitespace-nowrap">
            <span className="text-text-dim">{formatStat(k, now[k])} → </span>
            <span className={then[k] > now[k] ? "text-green" : "text-red"}>
              {formatStat(k, then[k])}
            </span>
          </span>
        </span>
      ))}
    </div>
  );
}
