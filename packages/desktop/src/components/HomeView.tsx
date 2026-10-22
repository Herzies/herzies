import {
  bankCapacity,
  CARD_SHAPE_CLIP,
  getItem,
  hasPickupSpiritEquipped,
  hasRoomFor,
  ItemTypeIcon,
  isBankFull,
  levelProgress,
} from "@herzies/shared";
import { useRef, useState } from "react";
import { useReportHomeStage } from "../hooks/useStageAlignment";
import { cn } from "../lib/utils";
import { type AppState, herzies, useGhostMode } from "../tauri-bridge";
import { HERZIE_STAGE_HEIGHT } from "./HerzieWithSky";
import { PLAYER_CARD, PLAYER_CARD_HOME, PlayerBars } from "./PlayerBars";
import { Tooltip } from "./Tooltip";
import { TrackCard } from "./TrackCard";

/** A pending world drop plus the ground x-position it was assigned on first
 * render. */
interface GroundDrop {
  id: string;
  itemId: string;
  /** Ground position, percent from the left, assigned once at spawn. */
  x: number;
}

/** Keep drops off the very edges of the scene. */
const DROP_X_MIN = 8;
const DROP_X_MAX = 92;

/** The now-playing card (a track, ghost mode, or nothing playing). */
const NOW_PLAYING_CARD =
  "h-full rounded-xl border border-white/12 bg-white/[0.03] px-2 py-1.5";

/** How long the pick-up fade-and-rise plays before the drop actually leaves. */
const DROP_EXIT_MS = 260;

export function HomeView({
  state,
  onOpenProfile,
  onActivity,
  active = true,
}: {
  state: AppState;
  /**
   * Home is the visible view. Views are only hidden with a CSS class, so
   * without this the creature and its sky keep animating inside a
   * `display: none` subtree for as long as the user is on another tab.
   */
  active?: boolean;
  /** Open the viewer's own profile (same layout as other herzies'). */
  onOpenProfile?: () => void;
  /** Surfaces a line in the activity log (e.g. a refused pickup). */
  onActivity?: (message: string) => void;
}) {
  const {
    herzie,
    nowPlaying,
    multipliers,
    isConnected,
    equipped,
    inventory,
    pendingDrops,
    bankExpansions,
  } = state;
  const capacity = bankCapacity(bankExpansions);
  const [collectingIds, setCollectingIds] = useState<Set<string>>(new Set());
  const ghostMode = useGhostMode();

  // Real drops have no ground position of their own (the server only tracks
  // id/itemId/droppedAt) — pick one client-side the first time a given drop
  // id is seen and keep it stable across re-renders for as long as that drop
  // lasts.
  const realDropXRef = useRef<Map<string, number>>(new Map());
  const realDropX = (id: string) => {
    let x = realDropXRef.current.get(id);
    if (x === undefined) {
      x = DROP_X_MIN + Math.random() * (DROP_X_MAX - DROP_X_MIN);
      realDropXRef.current.set(id, x);
    }
    return x;
  };

  // A spirit auto-collects drops server-side within one sync tick, so the
  // manual "Collect" affordance would almost always be stale — skip it when
  // one is worn. Except when the bank is full: then
  // auto-collect can't land anything either, so drops pile up right where a
  // spiritless player's would (same GROUND_DROP_CAP of 10) — showing them here
  // is what keeps that backlog visible instead of it building up unseen and
  // then landing in the bank all at once the moment a slot frees up.
  const hasSpirit = hasPickupSpiritEquipped(equipped);
  const bankFull = isBankFull(inventory, equipped, capacity);
  // Any number of drops can be pending at once — every item is independently
  // collectible.
  const dropItems: GroundDrop[] = pendingDrops.map((d) => ({
    id: d.id,
    itemId: d.itemId,
    x: realDropX(d.id),
  }));

  // Returns whether the drop was actually collected — the Rust side already
  // updates pendingDrops/inventory optimistically before its own network
  // call resolves, so `false` here means the server rejected it (already
  // gone, e.g. a racing Spirit Orb auto-collect) or the request failed.
  const performCollect = async (drop: GroundDrop): Promise<boolean> => {
    if (collectingIds.has(drop.id)) return false;
    // Refuse rather than pocketing something the bank can't hold: over-capacity
    // items stay owned but the grid has no slot to draw them in, so they'd
    // vanish from view (see reconcileSlotOrder). The drop keeps sitting on the
    // ground — pending drops never expire — so nothing is lost by waiting.
    //
    // hasRoomFor, not isBankFull: another copy of a stackable already in the
    // bank shares its slot and still fits at capacity.
    if (!hasRoomFor(inventory, equipped, drop.itemId, capacity)) {
      const name = getItem(drop.itemId)?.name ?? drop.itemId;
      onActivity?.(`Inventory full — couldn't pick up "${name}"`);
      return false;
    }
    setCollectingIds((prev) => new Set(prev).add(drop.id));
    try {
      return await herzies.collectDrop(drop.id);
    } catch (e: unknown) {
      // The server refuses an over-capacity collect too (the gate above is the
      // fast path, not the authority). Surface why instead of just letting the
      // item animate away and reappear, which reads as an unexplained glitch.
      const msg = e instanceof Error ? e.message : String(e);
      onActivity?.(`Couldn't pick that up: ${msg}`);
      return false;
    } finally {
      setCollectingIds((prev) => {
        if (!prev.has(drop.id)) return prev;
        const next = new Set(prev);
        next.delete(drop.id);
        return next;
      });
    }
  };

  // Picking one up plays a quick fade-and-rise, then stays hidden through
  // the collect call — `leavingKeys` only clears again if the collect
  // actually failed, letting the item reappear instead of leaving it stuck
  // invisible. On success there's nothing to clear: pendingDrops drops the
  // id (the Rust side updates it optimistically, before its network call
  // even resolves) so the item just stops being rendered. The key also
  // doubles as a guard against a drag sweep re-triggering the same item
  // while its exit is still playing.
  const [leavingKeys, setLeavingKeys] = useState<Set<string>>(new Set());

  const handleCollectDrop = (drop: GroundDrop) => {
    if (leavingKeys.has(drop.id)) return;
    setLeavingKeys((prev) => new Set(prev).add(drop.id));
    setTimeout(async () => {
      const collected = await performCollect(drop);
      if (!collected) {
        setLeavingKeys((prev) => {
          if (!prev.has(drop.id)) return prev;
          const next = new Set(prev);
          next.delete(drop.id);
          return next;
        });
      }
    }, DROP_EXIT_MS);
  };

  // The Herzie view lines its stage up with this one (see useStageAlignment).
  const viewRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  useReportHomeStage(viewRef, stageRef, active);

  if (!herzie) return null;

  return (
    <div ref={viewRef} className="flex h-full flex-col">
      {/* Top left, a frosted card: name and level, then health and
          experience — at least a third of the window wide. z-50: over the
          herzie canvas (z-index: 1), which would otherwise swallow the
          bars' tooltips. Top right, room for the nav. */}
      <div className="relative z-50 flex items-start justify-between gap-1.5">
        <div className={cn(PLAYER_CARD, PLAYER_CARD_HOME)}>
          <div className="flex h-5 items-center">
            <span className="text-ui-lg font-bold whitespace-nowrap text-cyan">
              <Tooltip label="View your profile">
                <button
                  type="button"
                  onClick={onOpenProfile}
                  className="cursor-pointer font-bold text-cyan hover:underline"
                >
                  {herzie.name}
                </button>
              </Tooltip>
              <span className="ml-2 text-[10px] font-normal text-text-dim">
                Lv. {herzie.level}
              </span>
            </span>
          </div>
          <PlayerBars
            level={herzie.level}
            progress={levelProgress(herzie)}
            xp={herzie.xp}
            multipliers={multipliers}
            className="mt-1 text-text-dim"
          />
        </div>
        <div className="flex h-5 items-center gap-1.5">
          {!isConnected && (
            <span className="text-[10px] text-red">
              connect to internet to grow
            </span>
          )}
          {/* Room for the nav (Home/World and Menu), which main.tsx puts
              over this corner, fixed, on every screen. */}
          <div
            aria-hidden="true"
            className="shrink-0"
            style={{ width: "var(--nav-width, 0px)" }}
          />
        </div>
      </div>

      {/* Whatever the fixed parts don't use, above the stage: everything below
          it is fixed-height, so the stage stays put, and it sits right on
          the level bar with the herzie standing on its floor. */}
      <div className="min-h-0 flex-1" />

      {/* The stage: HERZIE_STAGE_HEIGHT, the same as on the Herzie view. The
          herzie itself is drawn over it by main.tsx (one renderer shared with
          the Herzie view, so switching views doesn't reset it). */}
      <div
        ref={stageRef}
        className="relative flex shrink-0 items-center justify-center"
        style={{ height: HERZIE_STAGE_HEIGHT }}
      >
        {dropItems.length > 0 && (!hasSpirit || bankFull) && (
          // pointer-events-none on the wrapper keeps the gaps between items
          // from blocking herzie drag; each item re-enables pointer events
          // on itself. z-10: the herzie canvas sets its own z-index: 1 (see
          // HerzieWithSky.tsx), which otherwise sits above this overlay in the
          // stacking order and swallows clicks even though it's visually
          // behind. Items sit directly on the ground (no box/panel) at a
          // random x picked once at spawn.
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 h-0">
            {dropItems.map((drop) => {
              const item = getItem(drop.itemId);
              const isLeaving = leavingKeys.has(drop.id);
              return (
                // The absolute positioning (ground x-position) lives on this
                // outer span, not on the button below — Tooltip's own
                // trigger span only sizes/anchors correctly around content
                // that's actually in normal flow. Nesting a position:absolute
                // element straight inside it collapses that trigger span to
                // zero size at the wrong spot, which threw the tooltip's
                // placement off.
                <span
                  key={drop.id}
                  className="pointer-events-auto absolute bottom-0 -translate-x-1/2"
                  style={{ left: `${drop.x}%` }}
                >
                  <Tooltip label={item?.name ?? drop.itemId}>
                    <button
                      type="button"
                      // mousedown (not click) so a held-down button can be
                      // dragged across several drops in one gesture — see
                      // the onMouseEnter below, which picks up whatever's
                      // under the cursor while the button stays held.
                      onMouseDown={() => handleCollectDrop(drop)}
                      onMouseEnter={(e) => {
                        if (e.buttons === 1) handleCollectDrop(drop);
                      }}
                      disabled={isLeaving || collectingIds.has(drop.id)}
                      className="flex cursor-pointer flex-col items-center border-none bg-transparent p-0 disabled:cursor-default"
                    >
                      {/* The float animation and the pick-up exit both
                          apply here — only here, not to the shadow below —
                          so the item bobs while its shadow stays put on the
                          ground. */}
                      <div
                        className={cn(
                          "transition-all ease-out",
                          isLeaving
                            ? "-translate-y-2 opacity-0 duration-260"
                            : "animate-drop-float",
                        )}
                        style={
                          isLeaving
                            ? undefined
                            : { animationDelay: `${(drop.x * 37) % 2200}ms` }
                        }
                      >
                        {item ? (
                          <span className="relative inline-block h-6 w-6">
                            {/* Card-shaped backing in the app's own
                                background colour so the icon reads as an
                                opaque card instead of a bare wireframe
                                outline. */}
                            <span
                              aria-hidden="true"
                              className="absolute inset-0 bg-bg"
                              style={{ clipPath: CARD_SHAPE_CLIP }}
                            />
                            <ItemTypeIcon
                              item={item}
                              className="relative block h-6 w-6"
                            />
                          </span>
                        ) : (
                          // Always render the Collect action even if the
                          // item id isn't in this build's catalog — a real
                          // pending drop is never overwritten server-side,
                          // so if this affordance silently didn't render for
                          // an unrecognized id, that user could never get
                          // another drop. Falling back to the raw id keeps
                          // it clickable regardless.
                          <span className="text-[9px] text-text-dim">
                            {drop.itemId}
                          </span>
                        )}
                      </div>
                      <div className="h-1 w-5 rounded-full bg-black/40 blur-[1px]" />
                    </button>
                  </Tooltip>
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* A fixed height whatever is in it — a track, ghost mode, or nothing —
          so the herzie above doesn't move when music starts or stops. 64px is
          the track card's own height. A rounded card, like the chat's under
          it, 8px apart. */}
      <div className="relative z-10 mb-2 flex h-16 shrink-0 flex-col">
        {ghostMode ? (
          <div className={NOW_PLAYING_CARD}>
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
            tags={nowPlaying.tags}
            className={NOW_PLAYING_CARD}
          />
        ) : (
          <div
            className={cn(NOW_PLAYING_CARD, "flex items-center justify-center")}
          >
            <div className="text-center text-[10px] text-text-dim">
              Play some music to start earning XP
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
