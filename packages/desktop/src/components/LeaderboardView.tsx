import { totalXpForLevel, xpForLevel } from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import {
  herzies,
  type LeaderboardBoard,
  type LeaderboardEntry,
  useWindowFocused,
} from "../tauri-bridge";
import { List } from "./List";
import { TabButton } from "./TabButton";
import { View } from "./View";

const POLL_MS = 15_000;

type Tab = "level" | "song_hunt" | "tower";
/** All time or this month: the Level and Tower tabs have both. */
type Range = "all" | "month";
type Scope = "friends" | "global";

const TABS: { id: Tab; label: string }[] = [
  { id: "level", label: "Level" },
  { id: "song_hunt", label: "Song Hunt" },
  { id: "tower", label: "Tower" },
];

const SCOPES: { id: Scope; label: string }[] = [
  { id: "friends", label: "Friends" },
  { id: "global", label: "Global" },
];

const RANGES: { id: Range; label: string }[] = [
  { id: "all", label: "All time" },
  { id: "month", label: "This month" },
];

type Board = "xp" | "xp_month" | "song_hunt" | "tower" | "tower_month";

/** The board a tab shows, over the range where it has one. */
function boardOf(tab: Tab, range: Range): Board {
  if (tab === "level") return range === "month" ? "xp_month" : "xp";
  if (tab === "tower") return range === "month" ? "tower_month" : "tower";
  return tab;
}

const EMPTY: Record<Board, string> = {
  xp: "No herzies on the leaderboard yet.",
  xp_month: "Nobody has earned EXP this month yet.",
  song_hunt: "Nobody has found a song for Orphiez yet.",
  tower: "Nobody has cleared a Tower floor yet.",
  tower_month: "Nobody has cleared a floor of this month's Tower yet.",
};

export function LeaderboardView({
  herzieName,
  active,
}: {
  herzieName: string;
  /** False while the window is shut: no polling from behind the screen. */
  active: boolean;
}) {
  const [tab, setTab] = useState<Tab>("level");
  const [range, setRange] = useState<Range>("all");
  const [scope, setScope] = useState<Scope>("friends");
  const base = boardOf(tab, range);
  const board: LeaderboardBoard =
    scope === "friends" ? `${base}_friends` : base;
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const focused = useWindowFocused();

  // Fetch on opening (or switching board), refresh while focused.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setEntries(null);
    const load = () =>
      herzies
        .fetchLeaderboard(board)
        .then((res) => {
          if (!cancelled) setEntries(res.entries);
        })
        .catch(() => {});
    load();
    const interval = focused ? setInterval(load, POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [active, focused, board]);

  return (
    <View colour="cyan" childrenClassName="flex min-h-0 flex-col">
      <div className="mb-2 flex gap-1 border-b border-white/15 text-ui">
        {TABS.map((t) => (
          <TabButton
            key={t.id}
            active={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </TabButton>
        ))}
      </div>
      <div className="mb-1.5 flex gap-1">
        {SCOPES.map((sc) => (
          <TabButton
            key={sc.id}
            active={scope === sc.id}
            onClick={() => setScope(sc.id)}
          >
            {sc.label}
          </TabButton>
        ))}
      </div>
      {(tab === "level" || tab === "tower") && (
        <div className="mb-1.5 flex gap-1">
          {RANGES.map((r) => (
            <TabButton
              key={r.id}
              active={range === r.id}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </TabButton>
          ))}
        </div>
      )}
      <List className="min-h-0 flex-1">
        {entries === null ? (
          <div className="pt-5 text-center text-ui text-text-dim">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="pt-5 text-center text-ui text-text-dim">
            {EMPTY[base]}
          </div>
        ) : (
          entries.map((entry) => {
            const isMe = entry.name === herzieName;
            return (
              <div
                key={`${entry.rank}-${entry.name}`}
                className="flex items-center gap-2 border-b border-white/15 py-1.5 last:border-b-0"
              >
                <span
                  className={cn(
                    "w-6 shrink-0 text-right text-ui font-bold",
                    entry.rank === 1 ? "text-yellow" : "text-text-dim",
                  )}
                >
                  {entry.rank}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      "truncate text-ui",
                      isMe ? "font-bold text-cyan" : "text-text",
                    )}
                  >
                    {entry.name}
                  </div>
                </div>
                <span className="shrink-0 text-[10px] text-green">
                  {score(base, entry)}
                </span>
              </div>
            );
          })
        )}
      </List>
    </View>
  );
}

function score(board: Board, entry: LeaderboardEntry): string {
  if (board === "song_hunt") return `${entry.songHuntWins ?? 0} won`;
  if (board === "tower" || board === "tower_month") {
    return `Floor ${entry.towerFloor ?? 0}`;
  }
  // A server from before xp was sent: fall back to time listened.
  if (entry.xp == null) return formatMinutes(entry.totalMinutes);
  const lv = `Lv. ${entry.level}`;
  // This month's board sends the month's EXP, not the total.
  if (board === "xp_month") return `${lv} (+${entry.xp.toLocaleString()} exp)`;
  return `${lv} (${levelPercent(entry.level, entry.xp)}% exp)`;
}

/** How far into its current level a total of `xp` is, floored. */
function levelPercent(level: number, xp: number): number {
  const into = xp - totalXpForLevel(level);
  const pct = Math.floor((into / xpForLevel(level + 1)) * 100);
  return Math.min(99, Math.max(0, pct));
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
