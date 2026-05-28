import { Herzie3D, type HerzieProfile } from "@herzies/shared";
import { useState } from "react";
import { BackButton } from "./BackButton";
import { View } from "./View";

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ProfileView({
  profile,
  onBack,
  onTrade,
  onAdd,
  onRemove,
  canRemove,
  stageOverride,
}: {
  profile: HerzieProfile;
  onBack: () => void;
  onTrade: () => void;
  onAdd: () => void;
  onRemove: () => void;
  canRemove?: boolean;
  stageOverride?: number | null;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <View
      title={profile.name}
      backButton={<BackButton colour="green" onClick={onBack} />}
      action={profile.name}
      colour="green"
      childrenClassName="flex min-h-0 flex-col"
    >
      {profile.friendCode && (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Herzie3D
            userId={profile.friendCode}
            stage={stageOverride ?? profile.stage}
            isPlaying={!!profile.nowPlaying}
            wearables={profile.equipped ?? []}
          />
        </div>
      )}

      <div className="mb-2 flex justify-between text-ui text-text-dim">
        <span>Level {profile.level}</span>
        {profile.globalRank ? (
          <span
            title={
              profile.globalTotal
                ? `Ranked #${profile.globalRank} of ${profile.globalTotal}`
                : undefined
            }
          >
            #{profile.globalRank}
          </span>
        ) : (
          <span />
        )}
        <span>Stage {profile.stage}</span>
      </div>

      {profile.nowPlaying ? (
        <div className="mb-2">
          <div className="mb-1 text-[10px] text-text-dim">Now playing</div>
          <div className="text-ui text-cyan line-clamp-2">
            ♪ {profile.nowPlaying.title}
            <span className="text-text-dim">
              {" "}
              — {profile.nowPlaying.artist}
            </span>
          </div>
        </div>
      ) : profile.lastPlayed ? (
        <div className="mb-2">
          <div className="mb-1 text-[10px] text-text-dim">Last played</div>
          <div className="flex justify-between gap-2 text-ui">
            <span className="min-w-0 line-clamp-2 text-cyan">
              ♪ {profile.lastPlayed.title}
              <span className="text-text-dim">
                {" "}
                — {profile.lastPlayed.artist}
              </span>
            </span>
            <span className="shrink-0 text-[10px] text-text-dim">
              {formatTimeAgo(profile.lastPlayed.listenedAt)}
            </span>
          </div>
        </div>
      ) : null}

      {profile.topArtists && profile.topArtists.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 text-[10px] text-text-dim">Top Artists</div>
          {profile.topArtists.map((a, i) => (
            <div
              key={a.name}
              className="flex justify-between border-b border-[#222] py-0.5 text-ui"
            >
              <span className="text-text">
                {i + 1}. {a.name}
              </span>
              <span className="text-text-dim">{a.plays} plays</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex shrink-0 gap-1.5">
        <button type="button" className="btn text-purple" onClick={onTrade}>
          Trade
        </button>
        {!canRemove && (
          <button type="button" className="btn text-green" onClick={onAdd}>
            Add friend
          </button>
        )}
        {canRemove && confirmRemove ? (
          <>
            <button type="button" className="btn text-red" onClick={onRemove}>
              Yes, remove
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setConfirmRemove(false)}
            >
              Cancel
            </button>
          </>
        ) : canRemove ? (
          <button
            type="button"
            className="btn text-red"
            onClick={() => setConfirmRemove(true)}
          >
            Remove friend
          </button>
        ) : null}
      </div>
    </View>
  );
}
