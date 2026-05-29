"use client";

import { HerzieArt } from "../HerzieArt";

const STAGE_LABELS: Record<number, string> = {
  1: "baby",
  2: "teen",
  3: "champion",
};

const STAGE_COLOR_CLASS: Record<number, string> = {
  1: "text-yellow",
  2: "text-cyan",
  3: "text-purple",
};

interface LeaderboardEntryProps {
  rank: number;
  name: string;
  level: number;
  stage: number;
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
  totalMinutes: number;
  topGenres: string[];
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function rankColorClass(rank: number): string {
  if (rank === 1) return "text-yellow";
  if (rank === 2 || rank === 3) return "text-text";
  return "text-text-dim";
}

export function LeaderboardEntry({
  rank,
  name,
  level,
  stage,
  appearance,
  totalMinutes,
  topGenres,
}: LeaderboardEntryProps) {
  const borderClass = rank === 1 ? "border-yellow" : "border-border";

  return (
    <div
      className={`bg-bg-panel border ${borderClass} rounded-md px-4 py-3 flex items-center gap-4 text-inherit`}
    >
      {/* Rank */}
      <span
        className={`text-lg font-bold min-w-7 text-center shrink-0 ${rankColorClass(rank)}`}
      >
        {rank}
      </span>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-lg">{name}</span>
          <span className="text-[11px] text-text-dim">lv.{level}</span>
          <span
            className={`text-[11px] ${STAGE_COLOR_CLASS[stage] ?? "text-text"}`}
          >
            {STAGE_LABELS[stage] ?? `stage ${stage}`}
          </span>
        </div>

        <div className="text-xs text-text-dim mt-0.5">
          <span className="text-green">{formatMinutes(totalMinutes)}</span>
        </div>
      </div>
    </div>
  );
}
