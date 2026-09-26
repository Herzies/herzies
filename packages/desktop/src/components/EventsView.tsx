import type { BossFightView, Equipped, GameEvent } from "@herzies/shared";
import {
  getItem,
  RARITY_COLORS as ITEM_RARITY_COLORS,
  MERCHANT_NAME,
} from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { herzies, useWindowFocused } from "../tauri-bridge";
import { BackButton } from "./BackButton";
import { BossFightHelp, BossFightPanel, makeDebugBoss } from "./BossFightPanel";
import ItemInspectOverlay from "./ItemInspectOverlay";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
import { List } from "./List";
import { MerchantPanel } from "./MerchantPanel";
import { View } from "./View";

function formatCountdown(endsAt: string): string {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return "ended";
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  if (days > 0) return `${days}d ${h}h left`;
  if (hours > 0) return `${hours}h left`;
  return "< 1h left";
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  if (ms < 1000) return `${ms}ms ago`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

type SongHuntConfig = {
  trackTitle: string;
  trackArtist: string;
  rewardItemId: string;
  maxClaims: number;
  hints: Array<{
    text: string;
    unlocksAt: string;
    unlocked: boolean;
    hasAudio?: boolean;
    playsRemaining?: number;
  }>;
  firstFinders: Array<{
    name: string;
    claimedAt: string;
  }>;
};

const EVENTS_POLL_MS = 10_000;

/** List order, and what each event type is called on its card. */
const EVENT_TYPES: { type: string; label: string }[] = [
  { type: "boss_fight", label: "Boss Fight" },
  { type: "song_hunt", label: "Song Hunt" },
  { type: "merchant", label: MERCHANT_NAME },
];
const typeLabel = (type: string) =>
  EVENT_TYPES.find((t) => t.type === type)?.label ?? type;
const typeRank = (type: string) => {
  const i = EVENT_TYPES.findIndex((t) => t.type === type);
  return i === -1 ? EVENT_TYPES.length : i;
};

type EventCard = {
  /** What opening the card selects: an event id, or "song_hunt" for the hunt
   * view (which also covers "no hunt live, here's the last one"). */
  key: string;
  type: string;
  title: string;
  live: boolean;
  /** Ends-at when live, starts-at when upcoming. */
  at: string | null;
  detail?: string;
};

export function EventsView({
  eventsTabVisible,
  debugForceActive = false,
  debugForceBoss = false,
  equipped,
  currency = 0,
  onLog,
}: {
  /** Tab stays mounted but hidden; only poll while user is on Events. */
  eventsTabVisible: boolean;
  /** Debug: render the previous hunt as if it were live, to preview the active-event UI. */
  debugForceActive?: boolean;
  /** Debug: render a fixture boss, so the panel can be reviewed without a live one. */
  debugForceBoss?: boolean;
  /** Current deck, used to show set progress in the reward preview. */
  equipped?: Equipped | null;
  /** Player's coins, for George's buy buttons. */
  currency?: number;
  onLog?: (msg: string) => void;
}) {
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [upcoming, setUpcoming] = useState<GameEvent[]>([]);
  /** Open card (see EventCard.key); null shows the list. */
  const [selected, setSelected] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [previousEvent, setPreviousEvent] = useState<GameEvent | null>(null);
  const [nextHunt, setNextHunt] = useState<GameEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [inspectOverlay, setInspectOverlay] = useState<"item" | null>(null);
  const [inspectItemId, setInspectItemId] = useState<string | null>(null);
  const focused = useWindowFocused();

  // Optimistic override of playsRemaining, keyed by hint index — updated
  // immediately from a play response so the button reflects the new count
  // without waiting for the next poll cycle.
  const [audioOverrides, setAudioOverrides] = useState<Record<number, number>>(
    {},
  );
  const [playingHint, setPlayingHint] = useState<number | null>(null);
  // Spans the actual playback, not just the fetch — set once audio starts,
  // cleared on end/pause/error, so the button stays disabled for as long as
  // the clip is audibly playing (not just while the request is in flight).
  const [activeAudioHint, setActiveAudioHint] = useState<number | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const playHintAudio = async (eventId: string, hintIndex: number) => {
    if (playingHint !== null || activeAudioHint !== null) return;
    setPlayingHint(hintIndex);
    setAudioError(null);
    try {
      const { url, playsRemaining } = await herzies.playHintAudio(
        eventId,
        hintIndex,
      );
      setAudioOverrides((prev) => ({ ...prev, [hintIndex]: playsRemaining }));
      if (audioRef.current) {
        audioRef.current.src = url;
        setActiveAudioHint(hintIndex);
        await audioRef.current.play();
      }
    } catch (e) {
      setAudioError(
        e instanceof Error ? e.message : "Couldn't play hint audio",
      );
      setActiveAudioHint(null);
    } finally {
      setPlayingHint(null);
    }
  };

  // Load when the tab is actually opened, and keep it fresh only while the
  // window is up. This view stays mounted when hidden, so it previously also
  // fetched once on mount — meaning every launch paid for /events/previous-hunt
  // (a slow Vercel route) whether or not the player ever opened Events, and
  // opening the tab then immediately re-fetched the same two endpoints.
  // reloadKey is a trigger, not a value: George's stall bumps it after a buy.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-runs the fetch
  useEffect(() => {
    if (!eventsTabVisible) return;
    let cancelled = false;

    const refresh = () =>
      Promise.all([herzies.fetchActiveEvents(), herzies.fetchPreviousHunt()])
        .then(([active, previous]) => {
          if (cancelled) return;
          setEvents(active.events);
          setUpcoming(active.upcoming ?? []);
          setPreviousEvent(previous.events[0] ?? null);
          setNextHunt(previous.next);
          setLoading(false);
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });

    refresh();
    const interval = focused ? setInterval(refresh, EVENTS_POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [focused, eventsTabVisible, reloadKey]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-text-dim">
        Loading...
      </div>
    );
  }

  const back = <BackButton colour="cyan" onClick={() => setSelected(null)} />;

  const previousHunt =
    previousEvent?.type === "song_hunt" ? previousEvent : null;
  const debugBoss = debugForceBoss ? makeDebugBoss() : undefined;
  const liveEvents = [...events, ...(debugBoss ? [debugBoss] : [])];

  if (selected === null) {
    const cards: EventCard[] = liveEvents.map((e) => {
      const boss =
        e.type === "boss_fight" ? (e.config as unknown as BossFightView) : null;
      return {
        key: e.type === "song_hunt" ? "song_hunt" : e.id,
        type: e.type,
        title: e.title,
        live: true,
        at: e.endsAt,
        detail: boss
          ? boss.killed
            ? "Defeated!"
            : `HP ${Math.round(boss.hp)} / ${Math.round(boss.maxHp)}`
          : undefined,
      };
    });
    if (
      debugForceActive &&
      previousHunt &&
      !cards.some((c) => c.type === "song_hunt")
    ) {
      cards.push({
        key: "song_hunt",
        type: "song_hunt",
        title: previousHunt.title,
        live: true,
        at: previousHunt.endsAt,
      });
    }
    // One countdown per type that has nothing live. Older servers don't send
    // `upcoming`, so the hunt falls back to /events/previous-hunt's `next`.
    const nextByType = new Map(upcoming.map((u) => [u.type, u]));
    if (nextHunt && !nextByType.has("song_hunt")) {
      nextByType.set("song_hunt", nextHunt);
    }
    for (const [type, next] of nextByType) {
      if (cards.some((c) => c.type === type)) continue;
      cards.push({
        key: type === "song_hunt" ? "song_hunt" : next.id,
        type,
        title: next.title,
        live: false,
        at: next.startsAt,
      });
    }
    // A boss that just went down (or got away) keeps its results card for a
    // few days, like the hunt's previous answer below.
    if (
      previousEvent?.type === "boss_fight" &&
      !cards.some((c) => c.type === "boss_fight" && c.live) &&
      Date.now() - new Date(previousEvent.endsAt).getTime() < 3 * 86_400_000
    ) {
      const boss = previousEvent.config as unknown as BossFightView;
      cards.push({
        key: previousEvent.id,
        type: "boss_fight",
        title: previousEvent.title,
        live: false,
        at: null,
        detail: boss.killed ? "Defeated! See results" : "It got away",
      });
    }
    // Nothing live or scheduled, but last week's answer is still worth a look.
    if (previousHunt && !cards.some((c) => c.type === "song_hunt")) {
      cards.push({
        key: "song_hunt",
        type: "song_hunt",
        title: previousHunt.title,
        live: false,
        at: null,
        detail: "See last hunt's answer",
      });
    }
    cards.sort(
      (a, b) =>
        Number(b.live) - Number(a.live) || typeRank(a.type) - typeRank(b.type),
    );

    return (
      <View
        title="Events"
        colour="cyan"
        childrenClassName="flex min-h-0 flex-col"
      >
        {cards.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-center text-xs text-text-dim">
            Nothing happening right now. Check back later!
          </div>
        ) : (
          <List className="min-h-0 flex-1">
            {cards.map((card) => (
              <EventCardRow
                key={`${card.key}-${card.live}`}
                card={card}
                // Upcoming events have nothing to show yet except the hunt's
                // previous-results view.
                onOpen={
                  card.live || card.at === null || card.key === "song_hunt"
                    ? () => setSelected(card.key)
                    : undefined
                }
              />
            ))}
          </List>
        )}
      </View>
    );
  }

  const selectedEvent =
    liveEvents.find((e) => e.id === selected) ??
    (previousEvent?.id === selected ? previousEvent : undefined);

  if (selectedEvent?.type === "boss_fight") {
    return (
      <View
        title="Boss Fight"
        colour="cyan"
        childrenClassName="flex min-h-0 flex-col"
        backButton={back}
        action={<BossFightHelp />}
      >
        <BossFightPanel
          event={selectedEvent}
          paused={!eventsTabVisible || !focused}
          onInspectReward={(itemId) => setInspectItemId(itemId)}
          equipped={equipped}
        />
        {inspectItemId ? (
          <ItemInspectOverlay
            itemId={inspectItemId}
            onClose={() => setInspectItemId(null)}
            equipped={equipped}
          />
        ) : null}
      </View>
    );
  }

  if (selectedEvent?.type === "merchant") {
    return (
      <View
        title={MERCHANT_NAME}
        colour="yellow"
        childrenClassName="flex min-h-0 flex-col"
        backButton={back}
        action={formatCountdown(selectedEvent.endsAt)}
      >
        <MerchantPanel
          event={selectedEvent}
          currency={currency}
          equipped={equipped}
          onBought={() => setReloadKey((k) => k + 1)}
          onLog={onLog}
        />
      </View>
    );
  }

  if (selected !== "song_hunt") {
    // The opened event ended between polls.
    return (
      <View title="Events" colour="cyan" backButton={back}>
        <div className="flex h-full items-center justify-center text-center text-xs text-text-dim">
          This event has ended.
        </div>
      </View>
    );
  }

  const hunt =
    events.find((e) => e.type === "song_hunt") ??
    (debugForceActive ? (previousHunt ?? undefined) : undefined);
  const previousHuntConfig = previousHunt?.config as SongHuntConfig;
  const previousRewardItem = previousHuntConfig?.rewardItemId
    ? getItem(previousHuntConfig.rewardItemId)
    : undefined;
  const previousFinders = (previousHuntConfig?.firstFinders ?? [])
    .slice()
    .sort(
      (a, b) =>
        new Date(a.claimedAt).getTime() - new Date(b.claimedAt).getTime(),
    )
    .slice(0, 20);

  if (!hunt && (previousHunt || nextHunt)) {
    const nextStartsAt = nextHunt ? new Date(nextHunt.startsAt) : null;
    return (
      <View
        title="Events"
        colour="cyan"
        childrenClassName="flex min-h-0 flex-col"
        backButton={back}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div>
            <h2 className="text-ui-2xl mb-3 font-bold">
              Song Hunt{" "}
              {nextStartsAt ? (
                <span className="text-ui text-text-dim">
                  (
                  {Intl.DateTimeFormat("en-US", {
                    day: "numeric",
                    month: "short",
                  }).format(nextStartsAt)}
                  )
                </span>
              ) : null}
            </h2>

            <div className="text-ui-lg">
              {nextStartsAt
                ? `Starts in ${formatStartsIn(nextStartsAt)}.`
                : "No hunt scheduled yet."}
            </div>
          </div>

          {previousHunt ? (
            <div className="mt-4 flex min-h-0 flex-1 flex-col border-t border-border pt-4">
              <h2 className="text-ui-lg mb-3 font-bold">
                Previous{" "}
                <span className="text-ui text-text-dim">
                  (
                  {Intl.DateTimeFormat("en-US", {
                    day: "numeric",
                    month: "short",
                  }).format(new Date(previousHunt.startsAt))}
                  )
                </span>
              </h2>

              <div className="flex min-h-0 flex-1 flex-col gap-2">
                <div className="flex min-h-0 flex-1 flex-col gap-2">
                  <div className="flex flex-col gap-1">
                    <h2 className="text-ui font-bold text-text-dim">Type:</h2>
                    <div className="text-ui">Song Hunt</div>
                  </div>

                  <div className="flex flex-col gap-1">
                    <h2 className="text-ui font-bold text-text-dim">Answer:</h2>
                    <div className="text-ui">
                      {previousHuntConfig?.trackArtist} -{" "}
                      {previousHuntConfig?.trackTitle}
                    </div>
                  </div>

                  {previousHuntConfig.rewardItemId && previousRewardItem ? (
                    <div className="flex flex-col gap-1">
                      <h2 className="text-ui font-bold text-text-dim">
                        Reward:
                      </h2>
                      <div className="flex items-center gap-1 text-ui">
                        <ItemTypeIcon
                          item={previousRewardItem}
                          className="h-4 w-4 shrink-0"
                        />
                        <button
                          className="cursor-pointer border-none bg-transparent text-ui underline"
                          style={{
                            color:
                              ITEM_RARITY_COLORS[previousRewardItem.rarity],
                          }}
                          type="button"
                          onClick={() => setInspectOverlay("item")}
                        >
                          {previousRewardItem.name}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="flex min-h-0 flex-1 flex-col gap-1">
                    <h2 className="text-ui font-bold text-text-dim">
                      Finders ({previousFinders.length}):
                    </h2>

                    <List className="min-h-0 flex-1">
                      {previousFinders.length > 0 ? (
                        previousFinders.map((finder, i) => {
                          const elapsed = formatDuration(
                            new Date(finder.claimedAt).getTime() -
                              new Date(previousHunt.startsAt).getTime(),
                          );
                          return (
                            <div
                              key={`${finder.name}-${finder.claimedAt}`}
                              className="flex justify-between border-b border-border py-0.5 text-ui last:border-b-0"
                            >
                              <span className="text-yellow">
                                {i + 1}. {finder.name}
                              </span>
                              <span className="text-text-dim">{elapsed}</span>
                            </div>
                          );
                        })
                      ) : (
                        <div className="text-ui text-text-dim">
                          No finders from the previous hunt.
                        </div>
                      )}
                    </List>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {inspectOverlay === "item" && previousHuntConfig?.rewardItemId && (
          <ItemInspectOverlay
            itemId={previousHuntConfig.rewardItemId}
            onClose={() => setInspectOverlay(null)}
            equipped={equipped}
          />
        )}
      </View>
    );
  }

  if (!hunt) {
    return (
      <View title="Song Hunt" colour="cyan" backButton={back}>
        <div className="flex h-full items-center justify-center text-center text-xs text-text-dim">
          No active Song Hunt. Check back later!
        </div>
      </View>
    );
  }

  const config = hunt.config as {
    rewardItemId: string;
    maxClaims: number;
    hints: Array<{
      text: string;
      unlocksAt: string;
      unlocked: boolean;
      hasAudio?: boolean;
      playsRemaining?: number;
    }>;
    firstFinders: Array<{
      name: string;
      claimedAt: string;
    }>;
  };

  const rewardItem = getItem(config.rewardItemId);

  return (
    <View
      title="Song Hunt"
      colour="cyan"
      childrenClassName="flex flex-col h-full"
      backButton={back}
    >
      <div className="grid flex-1 place-items-center">
        <div>
          <div className="text-center text-cyan">{hunt.title}</div>
          <div className="text-ui text-text-dim mt-2">{hunt.description}</div>

          <div className="mt-3 flex flex-col gap-0.5 text-center text-[10px] text-text-dim">
            <div>Duration: {formatCountdown(hunt.endsAt)}</div>
            {rewardItem ? (
              <>
                <div className="flex items-center justify-center gap-1">
                  Reward:{" "}
                  <ItemTypeIcon
                    item={rewardItem}
                    className="h-4 w-4 shrink-0"
                  />
                  <button
                    className="cursor-pointer border-none bg-transparent text-ui underline"
                    style={{ color: ITEM_RARITY_COLORS[rewardItem.rarity] }}
                    type="button"
                    onClick={() => setInspectOverlay("item")}
                  >
                    {rewardItem.name}
                  </button>
                </div>
                <div>
                  Rewards left: {config.maxClaims - config.firstFinders.length}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div>
        <div>
          <div className="mb-2.5">
            <div className="mb-1 text-[10px] text-text-dim">Clues</div>
            {config.hints.map((hint, i) => (
              <div
                key={hint.unlocksAt}
                className="mb-1 border-b border-border py-1"
              >
                {hint.unlocked ? (
                  <div className="text-ui text-text">
                    {i + 1}. {hint.text}
                    {hint.hasAudio ? (
                      <>
                        <button
                          type="button"
                          disabled={
                            playingHint !== null ||
                            activeAudioHint !== null ||
                            (audioOverrides[i] ?? hint.playsRemaining) === 0
                          }
                          onClick={() => playHintAudio(hunt.id, i)}
                          className="ml-4 inline-block cursor-pointer border-none bg-transparent p-0 align-middle leading-none text-cyan disabled:cursor-not-allowed disabled:text-text-dim"
                        >
                          {activeAudioHint === i
                            ? "▶ playing…"
                            : (audioOverrides[i] ?? hint.playsRemaining ?? 0) >
                                0
                              ? "▶ play"
                              : "no plays left"}
                        </button>
                        {(audioOverrides[i] ?? hint.playsRemaining ?? 0) > 0 ? (
                          <span className="text-ui-sm text-text-dim">
                            {" "}
                            ({audioOverrides[i] ?? hint.playsRemaining}/3 left)
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <div className="font-mono text-ui text-text-dim">
                      {i + 1}.{" "}
                      <span className={hint.unlocked ? "" : "blur-[1px]"}>
                        {hint.text}
                      </span>
                    </div>
                    <div className="text-ui-sm text-[#444]">
                      unlocks{" "}
                      {formatCountdown(hint.unlocksAt).replace(" left", "")}
                    </div>
                  </>
                )}
              </div>
            ))}
            {audioError ? (
              <div className="text-ui-sm text-red">{audioError}</div>
            ) : null}
          </div>

          <div>
            <div className="mb-1 text-[10px] text-text-dim">
              Finders ({config?.firstFinders?.length ?? 0})
            </div>
            {config?.firstFinders?.length &&
            config?.firstFinders?.length > 0 ? (
              <List className="max-h-28">
                {config.firstFinders.map((finder, i) => (
                  <div
                    key={`${finder.name}-${finder.claimedAt}`}
                    className="flex justify-between border-b border-border py-0.5 text-ui last:border-b-0"
                  >
                    <span className="text-yellow">
                      {i + 1}. {finder.name}
                    </span>
                    <span className="text-text-dim">
                      {timeAgo(finder.claimedAt)}
                    </span>
                  </div>
                ))}
              </List>
            ) : (
              <div className="text-ui text-text-dim">
                No one has found it yet...
              </div>
            )}
          </div>
        </div>
      </div>

      {inspectOverlay === "item" && (
        <ItemInspectOverlay
          itemId={config.rewardItemId}
          onClose={() => setInspectOverlay(null)}
          equipped={equipped}
        />
      )}
      {/* biome-ignore lint/a11y/useMediaCaption: short game hint clips, no source track */}
      <audio
        ref={audioRef}
        hidden
        onEnded={() => setActiveAudioHint(null)}
        onPause={() => setActiveAudioHint(null)}
        onError={() => setActiveAudioHint(null)}
      />
    </View>
  );
}

function formatStartsIn(date: Date): string {
  const now = new Date();
  const diff = date.getTime() - now.getTime();
  if (diff <= 0) return "Today";
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const remainderMs = diff % (1000 * 60 * 60 * 24);
  const hours = Math.floor(remainderMs / (1000 * 60 * 60));

  if (days > 0) {
    return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  }
  const onlyHours = Math.floor(diff / (1000 * 60 * 60));
  return `${onlyHours}h`;
}

/** "2d 4h", "5h", "12m" — for card countdowns. */
function formatIn(at: string): string {
  const ms = new Date(at).getTime() - Date.now();
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

function EventCardRow({
  card,
  onOpen,
}: {
  card: EventCard;
  onOpen?: () => void;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui font-bold">{typeLabel(card.type)}</span>
        {card.live ? (
          <span className="text-ui-sm font-bold text-green">LIVE</span>
        ) : card.at ? (
          <span className="text-ui-sm text-yellow">SCHEDULED</span>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 text-ui text-text-dim">
        <span className="truncate">{card.title}</span>
        <span className="shrink-0">
          {card.at
            ? card.live
              ? `ends in ${formatIn(card.at)}`
              : `next in ${formatIn(card.at)}`
            : null}
        </span>
      </div>
      {card.detail ? (
        <div className="text-ui-sm text-text-dim">{card.detail}</div>
      ) : null}
    </>
  );

  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "block w-full cursor-pointer border-0 border-b border-border bg-transparent py-2 text-left last:border-b-0 hover:bg-bg-panel",
        card.live ? "text-text" : "text-text-dim",
      )}
    >
      {body}
    </button>
  ) : (
    <div className="border-b border-border py-2 text-text-dim last:border-b-0">
      {body}
    </div>
  );
}
