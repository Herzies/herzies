import { lastFmTrackUrl, levelProgress, xpToNextLevel } from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import {
  type AppState,
  herzies,
  useGhostMode,
  useWindowPinned,
} from "../tauri-bridge";
import { Coin } from "./Coin";
import { Herzie3D } from "./Herzie3D";
import { MarqueeText } from "./MarqueeText";
import { Tooltip } from "./Tooltip";

export function HomeView({
  state,
  stageOverride,
  onOpenProfile,
  onOpenSettings,
}: {
  state: AppState;
  stageOverride?: number | null;
  /** Open the viewer's own profile (same layout as other herzies'). */
  onOpenProfile?: () => void;
  onOpenSettings?: () => void;
}) {
  const { herzie, nowPlaying, multipliers, isConnected, equipped } = state;
  const [globalRank, setGlobalRank] = useState<number | undefined>(undefined);
  const [globalTotal, setGlobalTotal] = useState<number | undefined>(undefined);
  const pinned = useWindowPinned();
  const ghostMode = useGhostMode();
  const friendCode = herzie?.friendCode;

  const togglePin = () => {
    // setWindowPinned updates the shared pinned cache synchronously, so the
    // UI (and animation pausing) reflects the toggle immediately.
    herzies.setWindowPinned(!pinned).catch(() => {});
  };

  const toggleGhostMode = () => {
    herzies.setGhostMode(!ghostMode).catch(() => {});
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
          <Tooltip label="View your profile">
            <button
              type="button"
              onClick={onOpenProfile}
              className="cursor-pointer font-bold text-cyan hover:underline"
            >
              {herzie.name}
            </button>
          </Tooltip>
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
          <Tooltip label={pinned ? "Unpin window" : "Pin window"}>
            <button
              type="button"
              onClick={togglePin}
              className={cn(
                "flex h-5 w-5 cursor-pointer items-center justify-center rounded-lg border-none p-0",
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
          </Tooltip>
          <Tooltip label={ghostMode ? "Resume tracking" : "Pause tracking"}>
            <button
              type="button"
              onClick={toggleGhostMode}
              className={cn(
                "flex h-5 w-5 cursor-pointer items-center justify-center rounded-lg border-none p-0",
                ghostMode
                  ? "bg-purple/20 text-purple"
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
                aria-label={ghostMode ? "Ghost mode on" : "Ghost mode"}
                role="img"
              >
                <path d="M9 10h.01" />
                <path d="M15 10h.01" />
                <path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip label="Settings">
            <button
              type="button"
              onClick={onOpenSettings}
              className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-lg border-none bg-transparent p-0 text-text-dim hover:text-text"
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
                aria-label="Settings"
                role="img"
              >
                <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </Tooltip>
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
          equipped={equipped}
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
          <span className="text-yellow">
            <Coin amount={herzie.currency} animate />
          </span>
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

      {ghostMode ? (
        <div className="border-t border-border pt-1.5 pb-2">
          <div className="flex items-center gap-2">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-purple/15 text-purple">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                role="img"
              >
                <path d="M9 10h.01" />
                <path d="M15 10h.01" />
                <path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-ui font-bold text-purple">Ghost mode</div>
              <div className="text-[10px] text-text-dim">
                Music is not tracked
              </div>
            </div>
          </div>
        </div>
      ) : nowPlaying ? (
        <div className="relative overflow-hidden border-t border-border pt-1.5 pb-2">
          {nowPlaying.artistImageUrl ? (
            <div className="absolute inset-y-0 right-0 w-1/2 overflow-hidden">
              <img
                src={nowPlaying.artistImageUrl}
                alt=""
                aria-hidden="true"
                className="absolute inset-0 h-full w-full object-cover object-right"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
              {/* Darken so title/artist stay readable over the photo. */}
              <div className="absolute inset-0 bg-black/35" />
              {/* Fades the photo into the app background toward the left,
                  right at this box's own edge (the bar's 50% mark). */}
              <div className="absolute inset-0 bg-gradient-to-r from-bg-panel to-transparent" />
            </div>
          ) : null}
          <div className="relative flex gap-2">
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
              <MarqueeText
                text={nowPlaying.title}
                className="text-ui font-bold text-text"
              />
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
        <div className="border-t border-border pt-1.5 pb-2">
          <div className="text-center text-[10px] text-text-dim">
            Play some music to start earning XP
          </div>
        </div>
      )}
    </div>
  );
}
