import { lastFmTrackUrl, levelProgress, xpToNextLevel } from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { type AppState, herzies, useWindowPinned } from "../tauri-bridge";
import { Herzie3D } from "./Herzie3D";

export function HomeView({
  state,
  stageOverride,
  onOpenProfile,
}: {
  state: AppState;
  stageOverride?: number | null;
  /** Open the viewer's own profile (same layout as other herzies'). */
  onOpenProfile?: () => void;
}) {
  const { herzie, nowPlaying, multipliers, isConnected, equipped } = state;
  const [globalRank, setGlobalRank] = useState<number | undefined>(undefined);
  const [globalTotal, setGlobalTotal] = useState<number | undefined>(undefined);
  const pinned = useWindowPinned();
  const friendCode = herzie?.friendCode;

  const togglePin = () => {
    // setWindowPinned updates the shared pinned cache synchronously, so the
    // UI (and animation pausing) reflects the toggle immediately.
    herzies.setWindowPinned(!pinned).catch(() => {});
  };

  useEffect(() => {
    if (!friendCode) return;
    let cancelled = false;
    herzies.friendLookup([friendCode]).then((result) => {
      if (cancelled) return;
      setGlobalRank(result[friendCode]?.globalRank);
      setGlobalTotal(result[friendCode]?.globalTotal);
    });
    return () => {
      cancelled = true;
    };
  }, [friendCode]);

  if (!herzie) return null;

  const progress = levelProgress(herzie);
  const toNext = xpToNextLevel(herzie);
  const totalHours = (herzie.totalMinutesListened / 60).toFixed(1);
  const activeMultipliers = multipliers ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex items-center justify-between z-50">
        <span className="text-ui-lg font-bold text-cyan">
          <button
            type="button"
            onClick={onOpenProfile}
            className="cursor-pointer font-bold text-cyan hover:underline"
            title="View your profile"
          >
            {herzie.name}
          </button>
          {globalRank ? (
            <span
              className="ml-1 text-[10px] font-normal text-text-dim"
              title={
                globalTotal
                  ? `Ranked #${globalRank} of ${globalTotal}`
                  : undefined
              }
            >
              #{globalRank}
            </span>
          ) : null}
        </span>
        <div className="flex items-center gap-1.5">
          {!isConnected && (
            <span className="text-[10px] text-red">
              connect to internet to grow
            </span>
          )}
          <button
            type="button"
            onClick={togglePin}
            title={
              pinned
                ? "Unpin window — hide it when it loses focus"
                : "Pin window — keep it open when it loses focus"
            }
            className={cn(
              "flex cursor-pointer items-center rounded-lg border-none px-1.5 py-0.5",
              pinned
                ? "bg-cyan/20 text-cyan"
                : "bg-transparent text-text-dim hover:text-text",
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
              aria-label={pinned ? "Window pinned" : "Pin window"}
              role="img"
            >
              <path d="M12 17v5" />
              <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
            </svg>
          </button>
          <span
            className={cn(
              "rounded-lg px-2 py-0.5 text-[10px]",
              isConnected ? "bg-green/20 text-green" : "bg-red/20 text-red",
            )}
          >
            {isConnected ? "online" : "offline"}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Herzie3D
          userId={herzie.friendCode}
          stage={stageOverride ?? herzie.stage}
          isPlaying={!!nowPlaying}
          wearables={equipped}
        />
      </div>

      <div className="mb-1.5">
        <div className="mb-0.5 text-ui text-text-dim">
          <span>
            Level {herzie.level} (Stage {herzie.stage})
          </span>
        </div>
        <div className="flex h-2 gap-0.5">
          {Array.from({ length: 40 }, (_, i) => (
            <div
              key={i}
              className={cn(
                "flex-1",
                i < Math.round(progress * 40) ? "bg-green" : "bg-[#333]",
              )}
            />
          ))}
        </div>
        <div className="mt-0.5 text-right text-ui-sm text-text-dim">
          {Math.ceil(toNext)} XP to next
        </div>
      </div>

      <div className="mb-1.5 flex justify-between text-[10px] text-text-dim">
        <span>
          <span className="text-purple">{totalHours}h</span> music
        </span>
        <span>
          <span className="text-yellow">${herzie.currency}</span>
        </span>
        <span>
          <span className="text-green">{herzie.friendCodes.length}</span>{" "}
          friends
        </span>
        {herzie.streakDays > 0 && (
          <span>
            <span className="text-yellow">{herzie.streakDays}d</span> streak
          </span>
        )}
      </div>

      {!multipliers ? (
        <div className="mb-1.5 text-[10px] text-text-dim">
          <span className="text-yellow">Bonuses:</span> Log in to get bonuses
        </div>
      ) : activeMultipliers.length > 0 ? (
        <div className="mb-1.5">
          {activeMultipliers.map((m) => (
            <div key={m.name} className="flex justify-between text-[10px]">
              <span className="text-yellow">★ {m.name}</span>
              <span className="text-green">+{Math.round(m.bonus * 100)}%</span>
            </div>
          ))}
        </div>
      ) : null}

      {nowPlaying ? (
        <div className="border-t border-border pt-1.5">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                void herzies.openExternalUrl(
                  lastFmTrackUrl(nowPlaying.artist, nowPlaying.title),
                );
              }}
              title="Open on Last.fm"
              className="h-12 w-12 shrink-0 cursor-pointer overflow-hidden rounded border-none bg-[#333] p-0"
            >
              {nowPlaying.albumArtUrl ? (
                <img
                  src={nowPlaying.albumArtUrl}
                  alt={`${nowPlaying.title} album art`}
                  className="h-full w-full object-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              ) : null}
            </button>
            <div className="min-w-0 flex-1">
              <div className="line-clamp-1 text-ui font-bold text-text">
                {nowPlaying.title}
              </div>
              <div className="line-clamp-1 text-[10px] text-text-dim">
                {nowPlaying.artist}
              </div>
              {nowPlaying.tags && nowPlaying.tags.length > 0 ? (
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {nowPlaying.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-purple/15 px-1.5 py-px text-ui-sm lowercase text-purple"
                    >
                      {tag.toLowerCase()}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <div className="border-t border-border pt-1.5">
          <div className="text-center text-[10px] text-text-dim">
            Play some music to start earning XP
          </div>
        </div>
      )}
    </div>
  );
}
