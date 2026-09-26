import {
  bankCapacity,
  bossDamagePerMinute,
  getHerzieStats,
  getHerzieStatsFromUnits,
  getItem,
  hasRoomFor,
  isBankFull,
  levelProgress,
  xpToNextLevel,
} from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import {
  type AppState,
  herzies,
  useGhostMode,
  useWindowPinned,
} from "../tauri-bridge";
import { Herzie3D } from "./Herzie3D";
import { HEADER_ICON_HIT } from "./headerIconHit";
import { CARD_SHAPE_CLIP, ItemTypeIcon } from "./icons/ItemTypeIcon";
import { ModifiersButton } from "./ModifiersButton";
import { StatsButton } from "./StatsButton";
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

/** How long the pick-up fade-and-rise plays before the drop actually leaves. */
const DROP_EXIT_MS = 260;

export function HomeView({
  state,
  stageOverride,
  onOpenProfile,
  onOpenSettings,
  onActivity,
  active = true,
  bossHatedGenres,
}: {
  state: AppState;
  stageOverride?: number | null;
  /**
   * Home is the visible view. Views are only hidden with a CSS class, so
   * without this the creature and its sky keep animating inside a
   * `display: none` subtree for as long as the user is on another tab.
   */
  active?: boolean;
  /** Open the viewer's own profile (same layout as other herzies'). */
  onOpenProfile?: () => void;
  onOpenSettings?: () => void;
  /** Surfaces a line in the activity log (e.g. a refused pickup). */
  onActivity?: (message: string) => void;
  /** Hated genres of the live boss, if any — reddens the matching tag pills. */
  bossHatedGenres?: string[];
}) {
  const {
    herzie,
    nowPlaying,
    multipliers,
    isConnected,
    equipped,
    inventory,
    itemUpgrades,
    units,
    pendingDrops,
    bankExpansions,
  } = state;
  const capacity = bankCapacity(bankExpansions);
  const [globalRank, setGlobalRank] = useState<number | undefined>(undefined);
  const [globalTotal, setGlobalTotal] = useState<number | undefined>(undefined);
  const [collectingIds, setCollectingIds] = useState<Set<string>>(new Set());
  // Read off the copies, so each worn one counts at its OWN upgrade level. A
  // cache from before copies existed has none yet, and falls back to the
  // id-keyed levels until the first sync brings them.
  const stats =
    units.length > 0
      ? getHerzieStatsFromUnits(units)
      : getHerzieStats(equipped, itemUpgrades);
  const pinned = useWindowPinned();
  const ghostMode = useGhostMode();
  const friendCode = herzie?.friendCode;

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

  // A Spirit Orb auto-collects drops server-side within one sync tick, so the
  // manual "Collect" affordance would almost always be stale — skip it when
  // either ground slot has one equipped. Except when the bank is full: then
  // auto-collect can't land anything either, so drops pile up right where a
  // non-Orb player's would (same GROUND_DROP_CAP of 10) — showing them here
  // is what keeps that backlog visible instead of it building up unseen and
  // then landing in the bank all at once the moment a slot frees up.
  const hasSpiritOrb =
    equipped.ground_left === "spirit-orb" ||
    equipped.ground_right === "spirit-orb";
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
          <StatsButton stats={stats} />
          <ModifiersButton multipliers={multipliers} />
          <Tooltip label={pinned ? "Unpin window" : "Pin window"}>
            <button
              type="button"
              onClick={togglePin}
              className={cn(
                HEADER_ICON_HIT,
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
                HEADER_ICON_HIT,
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
              className={cn(
                HEADER_ICON_HIT,
                "flex h-5 w-5 cursor-pointer items-center justify-center rounded-lg border-none bg-transparent p-0 text-text-dim hover:text-text",
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

      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <Herzie3D
          userId={herzie.friendCode}
          stage={stageOverride ?? herzie.stage}
          isPlaying={!!nowPlaying}
          equipped={equipped}
          paused={!active}
        />
        {dropItems.length > 0 && (!hasSpiritOrb || bankFull) && (
          // pointer-events-none on the wrapper keeps the gaps between items
          // from blocking herzie drag; each item re-enables pointer events
          // on itself. z-10: the herzie canvas sets its own z-index: 1 (see
          // Herzie3D.tsx), which otherwise sits above this overlay in the
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
                          <span className="relative inline-block h-4 w-4">
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
                              className="relative block h-4 w-4"
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
                      <div className="h-1 w-3.5 rounded-full bg-black/40 blur-[1px]" />
                    </button>
                  </Tooltip>
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div className="mb-1.5">
        <div className="mb-0.5 flex items-baseline justify-between text-ui text-text-dim">
          <span>
            Level {herzie.level} (Stage {herzie.stage})
          </span>
          <span className="text-ui-sm">{Math.ceil(toNext)} XP to next</span>
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
      </div>

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
        <TrackCard
          title={nowPlaying.title}
          artist={nowPlaying.artist}
          albumArtUrl={nowPlaying.albumArtUrl}
          artistImageUrl={nowPlaying.artistImageUrl}
          tags={nowPlaying.tags}
          hatedGenres={bossHatedGenres}
          damagePerMinute={bossDamagePerMinute(stats)}
          className="border-t border-border pt-1.5 pb-2"
        />
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
