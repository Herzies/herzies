import type { HerzieProfile } from "@herzies/shared";
import { useEffect, useState } from "react";
import { BackButton } from "./BackButton";
import { Herzie3D } from "./Herzie3D";
import { ProfileBadges } from "./ProfileBadges";
import { TabButton } from "./TabButton";
import { TrackCard } from "./TrackCard";
import { View } from "./View";

/** Profile content tabs. "music" (now playing / last played) is the default. */
type ProfileTab = "music" | "artists";

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
  active = true,
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
  /**
   * This profile is on the visible view. Views are only hidden with a CSS
   * class, so without this the creature keeps animating behind whichever tab
   * the user actually switched to.
   */
  active?: boolean;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [tab, setTab] = useState<ProfileTab>("music");

  // The same ProfileView instance is reused as the viewer walks from one
  // herzie to the next, so the tab has to fall back to the default with the
  // profile — otherwise the second herzie opens on whichever tab was left
  // selected on the first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets on profile change, not on tab state
  useEffect(() => {
    setTab("music");
  }, [profile.friendCode]);

  // Drop recently played artists that came through without a name — they'd
  // otherwise render as a blank, rankless row.
  const topArtists = (profile.topArtists ?? []).filter((a) => a.name?.trim());

  return (
    <View
      title={profile.name}
      backButton={<BackButton colour="green" onClick={onBack} />}
      action={<ProfileBadges profile={profile} />}
      colour="green"
      childrenClassName="flex min-h-0 flex-col"
    >
      {profile.friendCode && (
        <div className="flex min-h-0 flex-1 items-center justify-center *:shrink-0">
          <Herzie3D
            userId={profile.friendCode}
            stage={stageOverride ?? profile.stage}
            isPlaying={isFriend ? !!profile.nowPlaying : false}
            equipped={profile.equipped ?? {}}
            paused={!active}
          />
        </div>
      )}

      {/* The herzie canvas paints at its own z-index: 1 (see shared's
          Herzie3D) and the sky sits fixed behind everything, so the text UI
          needs its own stacking context above them — otherwise a tall
          creature overlaps and hides these rows. */}
      <div className="relative z-10 shrink-0">
        <div className="mb-2">
          <div className="flex items-baseline gap-1.5">
            <span className="text-ui-lg font-bold text-text">
              {profile.name}
            </span>
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

        <div className="mb-2 flex gap-1 border-b border-border text-ui">
          <TabButton
            colour="green"
            active={tab === "music"}
            onClick={() => setTab("music")}
          >
            {isFriend && profile.nowPlaying ? "Now playing" : "Last played"}
          </TabButton>
          <TabButton
            colour="green"
            active={tab === "artists"}
            onClick={() => setTab("artists")}
          >
            Top Artists
          </TabButton>
        </div>

        {/* Fixed panel height: the herzie above takes the leftover space, so
            a shorter tab's content would otherwise let this whole block sink
            and the tab row would jump as the viewer switches tabs. Tall
            enough for the tallest panel — last played, whose time-ago line
            sits above a 48px track card. */}
        <div className="min-h-[72px]">
          {!isFriend ? (
            <div className="mb-2">
              <div className="text-ui-sm text-[#444]">
                Become friends to share music
              </div>
            </div>
          ) : tab === "music" ? (
            profile.nowPlaying ? (
              <TrackCard
                className="mb-2"
                title={profile.nowPlaying.title}
                artist={profile.nowPlaying.artist}
                albumArtUrl={profile.nowPlaying.albumArtUrl}
              />
            ) : profile.lastPlayed ? (
              <div className="mb-2">
                {/* The tab already says "Last played" — this line only carries
                    the when. */}
                <div className="mb-1 text-[10px] text-text-dim">
                  {formatTimeAgo(profile.lastPlayed.listenedAt)}
                </div>
                <TrackCard
                  title={profile.lastPlayed.title}
                  artist={profile.lastPlayed.artist}
                  albumArtUrl={profile.lastPlayed.albumArtUrl}
                />
              </div>
            ) : (
              <div className="mb-2 text-ui-sm text-[#444]">
                Nothing played yet
              </div>
            )
          ) : topArtists.length > 0 ? (
            <div className="mb-2">
              {topArtists.map((a, i) => (
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
          ) : (
            <div className="mb-2 text-ui-sm text-[#444]">
              No top artists yet
            </div>
          )}
        </div>

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
                <button
                  type="button"
                  className="btn text-red"
                  onClick={onRemove}
                >
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
      </div>
    </View>
  );
}
