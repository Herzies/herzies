import type { ActiveMultiplier } from "@herzies/shared";
import { cn } from "../lib/utils";
import { type AppState, useGhostMode } from "../tauri-bridge";
import { ModifiersButton } from "./ModifiersButton";
import { TrackCard } from "./TrackCard";

/** The rounded card itself; its tint comes from where it sits. */
const CARD = "h-full rounded-xl border border-white/12 px-2 py-1.5";

/**
 * What's playing (a track, ghost mode, or nothing), with the XP modifiers
 * star in its bottom right corner: on Home above the chat, and in the Town
 * under the player card.
 *
 * A fixed height whatever is in it, so nothing around it moves when music
 * starts or stops. 64px is the track card's own height.
 */
export function NowPlayingBox({
  nowPlaying,
  multipliers,
  tint,
  showTags = true,
  className,
}: {
  nowPlaying: AppState["nowPlaying"];
  /** Active XP modifiers (null: logged out). */
  multipliers: ActiveMultiplier[] | null;
  /** The card's background (and blur), matching the player card's. */
  tint: string;
  /** The track's genre tags (left out where the box is narrow). */
  showTags?: boolean;
  className?: string;
}) {
  const ghostMode = useGhostMode();
  const card = cn(CARD, tint);

  return (
    <div className={cn("relative flex h-16 shrink-0 flex-col", className)}>
      {ghostMode ? (
        <div className={card}>
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
        <TrackCard
          title={nowPlaying.title}
          artist={nowPlaying.artist}
          albumArtUrl={nowPlaying.albumArtUrl}
          artistImageUrl={nowPlaying.artistImageUrl}
          tags={showTags ? nowPlaying.tags : undefined}
          className={card}
        />
      ) : (
        <div className={cn(card, "flex items-center justify-center")}>
          <div className="px-5 text-center text-[10px] text-text-dim">
            Play music to earn XP and items
          </div>
        </div>
      )}
      {/* The modifiers star, bottom right, over whatever's in the card: its
          circle 9px in from the card's right and bottom edges, as the chat's
          send button is from its card's, so the star's centre lines up with
          the send arrow's (17.5px in) in the card right below. */}
      <div className="absolute right-[9px] bottom-[9px] z-10 flex">
        <ModifiersButton multipliers={multipliers} />
      </div>
    </div>
  );
}
