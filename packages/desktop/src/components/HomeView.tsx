import { levelProgress, xpToNextLevel } from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { type AppState, herzies } from "../tauri-bridge";
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
  const friendCode = herzie?.friendCode;

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
            className="font-bold text-cyan hover:underline"
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
            <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-[#333]">
              {nowPlaying.albumArtUrl ? (
                <img
                  src={nowPlaying.albumArtUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              ) : null}
            </div>
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
