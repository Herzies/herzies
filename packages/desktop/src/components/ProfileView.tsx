import type { HerzieProfile } from "@herzies/shared";
import { useState } from "react";
import { BackButton } from "./BackButton";
import { Herzie3D } from "./Herzie3D";
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
  isFriend,
  isSelf,
  requestPending,
  stageOverride,
}: {
  profile: HerzieProfile;
  onBack: () => void;
  onTrade: () => void;
  onAdd: () => void;
  onRemove: () => void;
  canRemove?: boolean;
  /**
   * Whether the viewer is friends with this herzie. Listening data (now
   * playing, last played, top artists) is only shown to friends.
   */
  isFriend?: boolean;
  /** This is the viewer's own profile — hide trade/friend actions. */
  isSelf?: boolean;
  /** A friend request to this herzie is already pending (sent or received). */
  requestPending?: boolean;
  stageOverride?: number | null;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <View
      title={profile.name}
      backButton={<BackButton colour="green" onClick={onBack} />}
      colour="green"
      childrenClassName="flex min-h-0 flex-col"
    >
      {profile.friendCode && (
        <div className="flex min-h-0 flex-1 items-center justify-center *:shrink-0">
          <Herzie3D
            userId={profile.friendCode}
            stage={stageOverride ?? profile.stage}
            isPlaying={isFriend ? !!profile.nowPlaying : false}
            wearables={profile.equipped ?? []}
          />
        </div>
      )}

      <div className="mb-2">
        <div className="flex items-baseline gap-1.5">
          <span className="text-ui font-bold text-text">{profile.name}</span>
          {profile.globalRank ? (
            <span
              className="text-[10px] text-text-dim"
              title={
                profile.globalTotal
                  ? `Ranked #${profile.globalRank} of ${profile.globalTotal}`
                  : undefined
              }
            >
              #{profile.globalRank}
            </span>
          ) : null}
        </div>
        <div className="text-ui text-text-dim">
          Level {profile.level} (Stage {profile.stage})
        </div>
      </div>

      {!isFriend ? (
        <div className="mb-2">
          <div className="text-ui-sm text-[#444]">
            Become friends to share music
          </div>
        </div>
      ) : profile.nowPlaying ? (
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

      {isFriend && profile.topArtists && profile.topArtists.length > 0 && (
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

      {!isSelf && (
        <div className="flex shrink-0 gap-1.5">
          <button type="button" className="btn text-purple" onClick={onTrade}>
            Trade
          </button>
          {!canRemove && requestPending && (
            <button type="button" className="btn text-text-dim" disabled>
              Request sent
            </button>
          )}
          {!canRemove && !requestPending && (
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
      )}
    </View>
  );
}
