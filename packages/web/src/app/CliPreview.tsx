"use client";

import { HerzieArt } from "./HerzieArt";

const SAMPLE_APPEARANCE = {
  headIndex: 1,
  eyesIndex: 0,
  mouthIndex: 1,
  accessoryIndex: 0,
  colorScheme: "purple",
};

function XpBar({ progress, width = 20 }: { progress: number; width?: number }) {
  const filled = Math.round(progress * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return (
    <span>
      <span className="text-green">[{bar}]</span>{" "}
      <span className="text-yellow">{Math.round(progress * 100)}%</span>
    </span>
  );
}

export function CliPreview() {
  return (
    <div className="bg-bg-panel border border-border rounded-lg overflow-hidden">
      {/* Title bar */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border text-xs">
        <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57] inline-block" />
        <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e] inline-block" />
        <span className="w-2.5 h-2.5 rounded-full bg-[#28c840] inline-block" />
        <span className="text-text-dim ml-2">herzies</span>
      </div>

      {/* Terminal content */}
      <div className="px-4 py-3 text-[13px] leading-relaxed">
        {/* Header */}
        <div>
          <span className="text-purple font-bold">♫ herzies</span>
          <span className="text-text-dim"> — listening</span>
        </div>

        {/* Main: art + stats */}
        <div className="flex flex-row mt-2 gap-2">
          <div className="leaderboard-herzie shrink-0">
            <HerzieArt appearance={SAMPLE_APPEARANCE} stage={1} size={13} />
          </div>

          <div className="flex flex-col gap-0.5 pl-1">
            <div>
              <span className="text-cyan font-bold">Mochi</span>
              <span className="text-text-dim"> — Baby (Stage 1)</span>
            </div>

            <div className="mt-1">
              <span className="font-bold">Level:</span>{" "}
              <span className="text-yellow">7</span>
            </div>
            <div>
              <span className="font-bold">XP: </span>
              <XpBar progress={0.65} />
              <span className="text-text-dim"> (87 to next)</span>
            </div>

            <div className="mt-1">
              <span className="font-bold">Music: </span>
              <span className="text-purple">12.4h (744 min)</span>
            </div>
            <div>
              <span className="font-bold">Code: </span>
              <span className="text-cyan">MCHI-7X2</span>
              <span className="text-text-dim"> (3 friendzies, +6% XP)</span>
            </div>
          </div>
        </div>

        {/* Now playing */}
        <div className="mt-2">
          <span className="text-green font-bold">♪ </span>
          <span className="font-bold">Midnight City</span>
          <span className="text-text-dim"> — M83</span>
          <span className="text-text-dim"> | +42 XP this session</span>
        </div>
      </div>
    </div>
  );
}
