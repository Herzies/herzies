"use client";

import { useCallback, useEffect, useState } from "react";
import { createSupabaseClient } from "@/lib/supabase";
import { LeaderboardEntry } from "./LeaderboardEntry";

const POLL_INTERVAL = 10_000;

interface HerzieRow {
  name: string;
  stage: number;
  level: number;
  appearance: {
    headIndex: number;
    eyesIndex: number;
    mouthIndex: number;
    accessoryIndex: number;
    limbsIndex?: number;
    bodyIndex?: number;
    legsIndex?: number;
    colorScheme: string;
  };
  total_minutes_listened: number;
  genre_minutes: Record<string, number>;
}

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

export function Leaderboard() {
  const [rows, setRows] = useState<HerzieRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLeaderboard = useCallback(async () => {
    const supabase = createSupabaseClient();
    const { data } = await supabase
      .from("herzies")
      .select(
        "name, stage, level, xp, appearance, total_minutes_listened, genre_minutes",
      )
      .order("xp", { ascending: false })
      .limit(100);
    setRows((data ?? []) as HerzieRow[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchLeaderboard();
    const interval = setInterval(fetchLeaderboard, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchLeaderboard]);

  if (loading) {
    return (
      <div className="bg-bg-panel border border-border rounded-md p-8 text-center text-text-dim text-[13px]">
        loading...
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="bg-bg-panel border border-border rounded-md p-8 text-center text-text-dim text-[13px]">
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
