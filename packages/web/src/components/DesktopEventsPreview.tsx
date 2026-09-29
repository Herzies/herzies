"use client";

import { getItem, RARITY_COLORS } from "@herzies/shared";

const WINDOW_WIDTH = 380;
const WINDOW_HEIGHT = 520;
const TITLEBAR_HEIGHT = 28;
const CONTENT_PADDING = 12;

const MOCK = {
  title: "Orphiez is in town",
  countdown: "Leaving town in 1d 14h",
  rewardItemId: "headphones",
  hints: [
    { text: "Released in '94. A name that aches.", unlocked: true },
    {
      text: "An artist's posthumous masterpiece.",
      unlocked: false,
      unlocksIn: "8h",
    },
    {
      text: "Track 3, side A.",
      unlocked: false,
      unlocksIn: "1d 4h",
    },
  ],
  firstFinders: [
    { name: "tofu", ago: "2m ago" },
    { name: "pippin", ago: "14m ago" },
    { name: "juno", ago: "1h 22m ago" },
  ],
};

export function DesktopEventsPreview() {
  const reward = getItem(MOCK.rewardItemId);

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

      {/* Body — mirrors EventsView for an active song hunt (Orphiez's visit) */}
      <div
        className="flex flex-col overflow-hidden"
        style={{
          height: WINDOW_HEIGHT - TITLEBAR_HEIGHT,
          padding: CONTENT_PADDING,
        }}
      >
        {/* Title + countdown */}
        <div className="mb-2">
          <div className="text-[13px] font-bold text-cyan">{MOCK.title}</div>
          <div className="text-[10px] text-text-dim">{MOCK.countdown}</div>
        </div>

        {reward && (
          <div className="text-center gap-2 mb-2 pb-2 border-b border-border">
            {/* <ItemDisplay item={reward} size={7} /> */}
            <div className="flex flex-col">
              <span className="text-[10px] text-text-dim">Reward</span>
              <span
                className="text-[11px]"
                style={{ color: RARITY_COLORS[reward.rarity] }}
              >
                {reward.name}
              </span>
            </div>
          </div>
        )}
        {/* Hints */}
        <div className="mb-2">
          <div className="text-[10px] text-text-dim mb-1">Hints</div>
          {MOCK.hints.map((hint, i) => (
            <div key={i} className="py-1 border-b border-border">
              {hint.unlocked ? (
                <div className="text-[11px] text-text">
                  {i + 1}. {hint.text}
                </div>
              ) : (
                <>
                  <div className="text-[11px] text-text-dim/70 font-mono">
                    {i + 1}.{" "}
                    <span style={{ filter: "blur(2px)" }}>{hint.text}</span>
                  </div>
                  <div className="text-[9px] text-text-dim/50">
                    unlocks in {hint.unlocksIn}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
        {/* First Finders */}
        <div>
          <div className="text-[10px] text-text-dim mb-1">First Finders</div>
          {MOCK.firstFinders.map((finder, i) => (
            <div
              key={i}
              className="flex justify-between text-[11px] py-0.5 border-b border-border"
            >
              <span className="text-yellow">{finder.name}</span>
              <span className="text-text-dim">{finder.ago}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
