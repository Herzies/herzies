import type { Herzie, HerzieStats, TitlesState } from "@herzies/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { herzies } from "../tauri-bridge";
import { StatsTab } from "./StatsTab";
import { TabButton } from "./TabButton";
import { TitlesTab } from "./TitlesTab";

export type StatsWindowTab = "stats" | "titles";

/**
 * The Stats window's inside: the stat points (once the server knows them)
 * and the Titles. The titles are fetched each time the window opens, so
 * the Titles tab can say it has something new before it's looked at.
 */
export function StatsWindow({
  herzie,
  stats,
  open,
  tab,
  onTabChange,
  refreshKey,
  onLog,
}: {
  herzie: Herzie;
  /** What the herzie's cards give. */
  stats: HerzieStats;
  /** The window is open (not just fading out). */
  open: boolean;
  tab: StatsWindowTab;
  onTabChange: (tab: StatsWindowTab) => void;
  /** Changes when titles may have been earned (a new one announced): the
   * list is fetched again if it's open. */
  refreshKey: string;
  onLog?: (msg: string) => void;
}) {
  const hasPoints = !!herzie.statPoints;
  const shown: StatsWindowTab = hasPoints ? tab : "titles";

  const [board, setBoard] = useState<TitlesState | null>(null);
  const [failed, setFailed] = useState(false);
  /** Only the latest fetch lands: an older one finishing late would put the
   * list back. */
  const fetchSeq = useRef(0);
  const load = useCallback(() => {
    const seq = ++fetchSeq.current;
    setFailed(false);
    herzies.fetchTitles().then(
      (next) => {
        if (seq === fetchSeq.current) setBoard(next);
      },
      (e: unknown) => {
        if (seq !== fetchSeq.current) return;
        setFailed(true);
        onLog?.(`Couldn't load titles: ${e}`);
      },
    );
  }, [onLog]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetched on opening, and again when a new title is announced while open
  useEffect(() => {
    if (open) load();
  }, [open, refreshKey]);

  /** NEW titles told to the server as seen this session: the tab's dot goes
   * at once, the pills stay until the list is next fetched. */
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const unseen =
    board?.earned.filter((t) => t.fresh && !seen.has(t.id)).length ?? 0;
  const viewing = open && shown === "titles";
  useEffect(() => {
    if (!viewing || !board) return;
    const ids = board.earned
      .filter((t) => t.fresh && !seen.has(t.id))
      .map((t) => t.id);
    if (ids.length === 0) return;
    // A beat on screen first, so a glance through the tab doesn't count.
    const t = setTimeout(() => {
      setSeen((s) => new Set([...s, ...ids]));
      herzies.markTitlesSeen(ids).catch((e: unknown) => {
        onLog?.(`Couldn't mark titles as seen: ${e}`);
      });
    }, 1_200);
    return () => clearTimeout(t);
  }, [viewing, board, seen, onLog]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex h-6 shrink-0 items-center gap-1 border-b border-white/15">
        {hasPoints && (
          <TabButton
            active={shown === "stats"}
            onClick={() => onTabChange("stats")}
          >
            Stats
          </TabButton>
        )}
        <TabButton
          active={shown === "titles"}
          onClick={() => onTabChange("titles")}
        >
          <span className="relative">
            Titles
            {unseen > 0 && (
              <span
                role="img"
                aria-label={`${unseen} new`}
                className="absolute -top-0.5 -right-2 h-1.5 w-1.5 rounded-full bg-yellow"
              />
            )}
          </span>
        </TabButton>
      </div>
      {shown === "stats" && herzie.statPoints ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <StatsTab
            stats={stats}
            level={herzie.level}
            points={herzie.statPoints}
            cls={herzie.class}
            onLog={onLog}
          />
        </div>
      ) : (
        <TitlesTab
          name={herzie.name}
          worn={herzie.title ?? null}
          board={board}
          failed={failed}
          onRetry={load}
          onLog={onLog}
        />
      )}
    </div>
  );
}
