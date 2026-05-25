"use client";

import { Herzie3D, Sky } from "@herzies/shared";

const WINDOW_WIDTH = 380;
const WINDOW_HEIGHT = 520;
const TITLEBAR_HEIGHT = 28;
const CONTENT_PADDING = 12;
const SIZE = 4;

// Inner content width minus padding, divided by char width.
const SKY_COLS = Math.floor(
  (WINDOW_WIDTH - CONTENT_PADDING * 2) / (SIZE * 0.6),
);

const MOCK = {
  name: "mochi",
  stage: 2,
  level: 4,
  progress: 0.6,
  xpToNext: 142,
  totalHours: "12.3",
  currency: 42,
  friends: 3,
  streakDays: 5,
  bonuses: [
    { name: "Daily Streak", bonus: 0.15 },
    { name: "Weekend Boost", bonus: 0.25 },
  ],
  nowPlaying: {
    title: "Ghost2",
    artist: "Two Shell",
    tags: ["electronic", "uk bass", "deconstructed club"],
    vibe: "hypnotic",
  },
};

export function DesktopHomePreview() {
  return (
    <div className="mx-auto rounded-lg overflow-hidden shadow-2xl border border-border bg-bg-panel w-[380px] max-w-full">
      {/* macOS-style title bar */}
      <div
        className="flex items-center px-3 border-b border-border bg-bg"
        style={{ height: TITLEBAR_HEIGHT }}
      >
        <div className="flex gap-1.5">
          <span className="block w-3 h-3 rounded-full bg-[#ff5f57]" />
          <span className="block w-3 h-3 rounded-full bg-[#febc2e]" />
          <span className="block w-3 h-3 rounded-full bg-[#28c840]" />
        </div>
        <span className="flex-1 text-center text-[11px] text-text-dim -ml-12">
          Herzies
        </span>
      </div>

      {/* App body — mirrors HomeView */}
      <div
        className="relative flex flex-col"
        style={{
          height: WINDOW_HEIGHT - TITLEBAR_HEIGHT,
          padding: CONTENT_PADDING,
        }}
      >
        {/* Sky anchored to the top of the window body */}
        <Sky
          userId={MOCK.name}
          cols={SKY_COLS}
          size={SIZE}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            width: "100%",
            zIndex: 0,
          }}
        />

        {/* Header */}
        <div className="relative z-10 flex justify-between items-center mb-1">
          <span className="text-[13px] font-bold text-cyan">{MOCK.name}</span>
          <span className="text-[10px] text-green bg-green/10 px-2 py-0.5 rounded-md">
            online
          </span>
        </div>

        {/* Herzie — takes available space */}
        <div className="relative z-10 flex-1 flex items-center justify-center min-h-0">
          <Herzie3D
            userId={MOCK.name}
            stage={MOCK.stage}
            size={SIZE}
            isPlaying
            ariaLabel={`A stage ${MOCK.stage} herzie named ${MOCK.name}`}
            defaultAngle={50}
          />
        </div>

        {/* Level & XP */}
        <div className="relative z-10 mb-1.5">
          <div className="flex justify-between text-[11px] text-text-dim mb-1">
            <span>Level {MOCK.level}</span>
            <span>Stage {MOCK.stage}</span>
          </div>
          <div className="flex gap-0.5 h-2">
            {Array.from({ length: 40 }, (_, i) => (
              <div
                key={i}
                className="flex-1"
                style={{
                  background:
                    i < Math.round(MOCK.progress * 40) ? "#4ade80" : "#333",
                }}
              />
            ))}
          </div>
          <div className="text-[9px] text-text-dim/60 mt-0.5 text-right">
            {MOCK.xpToNext} XP to next
          </div>
        </div>

        {/* Stats row */}
        <div className="relative z-10 flex justify-between text-[10px] text-text-dim mb-1.5">
          <span>
            <span className="text-purple">{MOCK.totalHours}h</span> music
          </span>
          <span className="text-yellow">${MOCK.currency}</span>
          <span>
            <span className="text-cyan">{MOCK.friends}</span> friends
          </span>
          <span>
            <span className="text-yellow">{MOCK.streakDays}d</span> streak
          </span>
        </div>

        {/* Bonuses */}
        <div className="relative z-10 mb-1.5">
          {MOCK.bonuses.map((m) => (
            <div key={m.name} className="flex justify-between text-[10px]">
              <span className="text-yellow">★ {m.name}</span>
              <span className="text-green">+{Math.round(m.bonus * 100)}%</span>
            </div>
          ))}
        </div>

        {/* Now playing */}
        <div className="relative z-10 border-t border-border pt-1.5">
          <div className="text-[9px] text-text-dim mb-0.5">♫ Now Playing</div>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <div className="line-clamp-1 text-[11px] font-bold text-text">
                {MOCK.nowPlaying.title}
              </div>
              <div className="line-clamp-1 text-[10px] text-text-dim">
                {MOCK.nowPlaying.artist}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
