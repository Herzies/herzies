"use client";

import { useCallback, useEffect, useState } from "react";
import { useLoaderHold } from "@/components/page-loader/useLoaderHold";
import { createSupabaseClient } from "@/lib/supabase";
import { fetchLeaderboard, type HerzieRow } from "./data";
import { LeaderboardEntry } from "./LeaderboardEntry";

const POLL_INTERVAL = 10_000;

function getTopGenres(
  genreMinutes: Record<string, number>,
  count = 3,
): string[] {
  return Object.entries(genreMinutes)
    .sort(([, a], [, b]) => b - a)
    .slice(0, count)
    .filter(([, mins]) => mins > 0)
    .map(([genre]) => genre);
}

/** `initialRows` come from the server (null if it couldn't reach the
 * database); the browser keeps them fresh. */
export function Leaderboard({
  initialRows,
}: {
  initialRows: HerzieRow[] | null;
}) {
  const [rows, setRows] = useState(initialRows);

  const refresh = useCallback(async () => {
    const fresh = await fetchLeaderboard(createSupabaseClient());
    // A failed poll keeps what's shown; a failed first load shows the
    // empty board rather than loading forever.
    setRows((shown) => fresh ?? shown ?? []);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [refresh]);

  // The page loader stays up until the first rows are in.
  const loading = rows === null;
  useLoaderHold(loading);

  if (loading) {
    return (
      <div className="bg-bg-panel border border-border rounded-2xl p-8 text-center text-text-dim text-[13px]">
        loading...
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="bg-bg-panel border border-border rounded-2xl p-8 text-center text-text-dim text-[13px]">
        no herzies found yet. be the first!
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.map((herzie, i) => (
        <LeaderboardEntry
          key={herzie.name}
          rank={i + 1}
          name={herzie.name}
          level={herzie.level}
          stage={herzie.stage}
          appearance={herzie.appearance}
          totalMinutes={Math.floor(herzie.total_minutes_listened)}
          topGenres={getTopGenres(herzie.genre_minutes)}
        />
      ))}
    </div>
  );
}
