import { lastFmTrackUrl } from "@herzies/shared";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { MarqueeText } from "./MarqueeText";

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
  className,
}: {
  title: string;
  artist: string;
  albumArtUrl?: string;
  /** Photo bled in behind the text, right-aligned. */
  artistImageUrl?: string;
  tags?: string[];
  className?: string;
}) {
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
          {tags && tags.length > 0 ? (
            <div className="mt-0.5 flex flex-wrap gap-1">
              {tags.map((tag) => (
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
  );
}
