import {
  BOSS_DAMAGE_PER_MINUTE,
  classifyGenre,
  lastFmTrackUrl,
} from "@herzies/shared";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { MarqueeText } from "./MarqueeText";
import { Tooltip } from "./Tooltip";

/** A now-playing tag. Red, with a tooltip, when it is dealing damage to a boss. */
function GenrePill({
  tag,
  hurts,
  damagePerMinute,
}: {
  tag: string;
  hurts: boolean;
  damagePerMinute: number;
}) {
  const pill = (
    <span
      className={cn(
        "cursor-default rounded-full px-1.5 py-px text-ui-sm lowercase",
        hurts ? "bg-red/20 text-red" : "bg-purple/15 text-purple",
      )}
    >
      {tag.toLowerCase()}
    </span>
  );
  if (!hurts) return pill;
  return (
    <Tooltip
      label={`Dealing ${Number(damagePerMinute.toFixed(2))} damage per minute`}
    >
      {pill}
    </Tooltip>
  );
}

/**
 * A track with its album art, title and artist — the home screen's now-playing
 * card, also used for a profile's now playing / last played so the two read
 * identically. `artistImageUrl` and `tags` only come through on the viewer's
 * own now-playing (a profile lookup doesn't carry them), and each is simply
 * left out when missing.
 */
export function TrackCard({
  title,
  artist,
  albumArtUrl,
  artistImageUrl,
  tags,
  hatedGenres,
  damagePerMinute = BOSS_DAMAGE_PER_MINUTE,
  meta,
  className,
}: {
  title: string;
  artist: string;
  albumArtUrl?: string;
  /** Photo bled in behind the text, right-aligned. */
  artistImageUrl?: string;
  tags?: string[];
  /**
   * Genres a live boss hates. Any tag that classifies into one of these is
   * currently dealing damage, and gets a red pill to say so.
   */
  hatedGenres?: string[];
  /** Damage per minute the player's listening deals to a boss, sonic power
   * included — what the red pills' tooltip says. */
  damagePerMinute?: number;
  /** Extra dim line under the artist, e.g. how long ago it was played. */
  meta?: string;
  className?: string;
}) {
  const hated = hatedGenres ?? [];

  return (
    <div className={cn("relative overflow-hidden", className)}>
      {artistImageUrl ? (
        <div className="absolute inset-y-0 right-0 w-1/2 overflow-hidden">
          <img
            src={artistImageUrl}
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
            void herzies.openExternalUrl(lastFmTrackUrl(artist, title));
          }}
          title="Open on Last.fm"
          className="h-12 w-12 shrink-0 cursor-pointer overflow-hidden rounded border-none bg-[#333] p-0"
        >
          {albumArtUrl ? (
            <img
              src={albumArtUrl}
              alt={`${title} album art`}
              className="h-full w-full object-cover"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          ) : null}
        </button>
        <div className="min-w-0 flex-1">
          <MarqueeText text={title} className="text-ui font-bold text-text" />
          <div className="line-clamp-1 text-[10px] text-text-dim">{artist}</div>
          {meta ? (
            <div className="text-[10px] text-text-dim/70">{meta}</div>
          ) : null}
          {tags && tags.length > 0 ? (
            <div className="mt-0.5 flex flex-wrap gap-1">
              {tags.map((tag) => {
                // Tags are raw Last.fm strings ("house", "techno") while a
                // boss hates entries from the 15-value GENRES union, so the
                // two have to be compared through the classifier rather than
                // by string equality — "house" and "techno" both land on
                // "electronic", and both really are dealing damage.
                const hurts =
                  hated.length > 0 &&
                  classifyGenre([tag]).some((g) => hated.includes(g));
                return (
                  <GenrePill
                    key={tag}
                    tag={tag}
                    hurts={hurts}
                    damagePerMinute={damagePerMinute}
                  />
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
