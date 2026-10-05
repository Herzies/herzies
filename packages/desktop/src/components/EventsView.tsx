import type {
  BossFightView,
  Equipped,
  GameEvent,
  ItemUnit,
} from "@herzies/shared";
import {
  getItem,
  RARITY_COLORS as ITEM_RARITY_COLORS,
  isVisitorType,
  MERCHANT_NAME,
  VISITORS,
  visitorName,
} from "@herzies/shared";
import { memo, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { herzies, useWindowFocused } from "../tauri-bridge";
import { BackButton } from "./BackButton";
import { BossFightHelp, BossFightPanel, makeDebugBoss } from "./BossFightPanel";
import ItemInspectOverlay, {
  INSPECT_ORIGIN_ATTR,
  inspectOrigin,
} from "./ItemInspectOverlay";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
import { VisitorIcon } from "./icons/VisitorIcon";
import { List } from "./List";
import { MerchantPanel } from "./MerchantPanel";
import { OrphiezStage } from "./OrphiezStage";
import { TabButton } from "./TabButton";
import { View } from "./View";
import { VisitorHelp } from "./VisitorHelp";
import {
  ROW_TEXT_SHADOW,
  VISITOR_THEMES,
  VisitorSparkles,
} from "./VisitorRowTheme";

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

/** Fixture George for the Settings debug toggle. Not a real event, so any
 * buy is refused server-side — this is for looking, not shopping. */
const DEBUG_MERCHANT: GameEvent = {
  id: "debug-merchant",
  type: "merchant",
  title: MERCHANT_NAME,
  description: "He's got stuff. Good stuff.",
  active: true,
  startsAt: new Date(Date.now() - 3_600_000).toISOString(),
  endsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  config: {
    stock: [
      {
        itemId: "cd",
        price: 25,
        perPlayerLimit: 3,
        totalStock: 40,
        remaining: 31,
        yourBought: 1,
      },
      {
        itemId: "spirit-orb",
        price: 900,
        perPlayerLimit: 1,
        totalStock: null,
        remaining: null,
        yourBought: 0,
      },
      {
        itemId: "headphones",
        price: 400,
        perPlayerLimit: null,
        totalStock: 5,
        remaining: 0,
        yourBought: 0,
      },
    ],
  },
};

/** List order of the visitors that always get a card in Town. */
const EVENT_TYPES: { type: string }[] = [
  { type: "boss_fight" },
  { type: "song_hunt" },
  { type: "merchant" },
];
/** "<name> <tagline>" reads as a sentence; the card shows the tagline under
 * the name, so it's capitalised there. */
const taglineOf = (type: string) => {
  const t = isVisitorType(type) ? VISITORS[type].tagline : "";
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : undefined;
};
const typeRank = (type: string) => {
  const i = EVENT_TYPES.findIndex((t) => t.type === type);
  return i === -1 ? EVENT_TYPES.length : i;
};

type EventCard = {
  type: string;
  title: string;
  description: string | null;
  status: "live" | "scheduled" | "idle";
  /** Ends-at when live, starts-at when scheduled. */
  at: string | null;
  detail?: string;
  /** What opening the card selects (an event id, or "song_hunt" for the hunt
   * view); null when there is nothing to open yet. */
  openKey: string | null;
  /** For a stable React key. */
  eventId?: string;
};

function EventsViewImpl({
  eventsTabVisible,
  debugForceActive = false,
  debugForceBoss = false,
  debugForceMerchant = false,
  onScreenChange,
  equipped,
  units = [],
  currency = 0,
  onLog,
  rootKey = 0,
}: {
  /** Tab stays mounted but hidden; only poll while user is on Events. */
  eventsTabVisible: boolean;
  /** Bumped when the Town tab is re-selected while already on it: back to
   * the visitor list. */
  rootKey?: number;
  /** Debug: render the previous hunt as if it were live, to preview the active-event UI. */
  debugForceActive?: boolean;
  /** Debug: render a fixture boss, so the panel can be reviewed without a live one. */
  debugForceBoss?: boolean;
  /** Debug: a fixture Good ol' George visit (buying from it will fail). */
  debugForceMerchant?: boolean;
  /** Which full-screen event view is open, so the app can recolour the
   * window: a live boss blacks it out, George turns it gold. */
  onScreenChange?: (screen: "boss" | "merchant" | null) => void;
  /** Current deck, used to show set progress in the reward preview. */
  equipped?: Equipped | null;
  /** Every owned copy, for George's "N owned" counts. */
  units?: readonly ItemUnit[];
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
  const [activeLoaded, setActiveLoaded] = useState(false);
  const [previousLoaded, setPreviousLoaded] = useState(false);
  const [previousKey, setPreviousKey] = useState(0);
  const liveIdsRef = useRef<string | null>(null);

  const [inspectOverlay, setInspectOverlay] = useState<"item" | null>(null);

  // Re-selecting Town closes whichever visitor is open. Compared against the
  // last key rather than run on mount, so it only ever fires on a bump.
  const rootKeyRef = useRef(rootKey);
  useEffect(() => {
    if (rootKeyRef.current === rootKey) return;
    rootKeyRef.current = rootKey;
    setSelected(null);
    setInspectOverlay(null);
  }, [rootKey]);
  const [huntTab, setHuntTab] = useState<"clues" | "finders">("clues");
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
  // fetched once on mount — meaning every launch paid for these whether or
  // not the player ever opened Events, and opening the tab then immediately
  // re-fetched the same endpoints.
  // reloadKey is a trigger, not a value: George's stall bumps it after a buy.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-runs the fetch
  useEffect(() => {
    if (!eventsTabVisible) return;
    let cancelled = false;

    const refresh = () =>
      herzies
        .fetchActiveEvents()
        .then((active) => {
          if (cancelled) return;
          setEvents(active.events);
          setUpcoming(active.upcoming ?? []);
          setActiveLoaded(true);
          // A visit started or ended: the previous hunt / next hunt may have
          // moved too. The first load just records the set.
          const ids = active.events.map((e) => e.id).join(",");
          if (liveIdsRef.current !== null && liveIdsRef.current !== ids) {
            setPreviousKey((k) => k + 1);
          }
          liveIdsRef.current = ids;
        })
        .catch(() => {
          if (!cancelled) setActiveLoaded(true);
        });

    refresh();
    const interval = focused ? setInterval(refresh, EVENTS_POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [focused, eventsTabVisible, reloadKey]);

  // /events/previous-hunt returns the last ended hunt *or* boss, whichever is
  // newer. While Orphiez is in town his card is live and never shows the last
  // hunt, so the call is only needed for the boss card's results — and not
  // even that while a boss is live too.
  const huntIsLive = events.some((e) => e.type === "song_hunt");
  const bossIsLive = events.some((e) => e.type === "boss_fight");
  const previousNeeded = !(huntIsLive && bossIsLive);

  // /events/previous-hunt (a slow Vercel route) only changes when a visit
  // ends or starts, so it isn't polled with the active events: it's fetched
  // when the tab opens and again when the poll sees the live set change.
  // Waits for the active events, which decide whether it's needed at all.
  // previousKey is a trigger, not a value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: previousKey re-runs the fetch
  useEffect(() => {
    if (!eventsTabVisible || !activeLoaded) return;
    if (!previousNeeded) {
      setPreviousLoaded(true);
      return;
    }
    let cancelled = false;
    herzies
      .fetchPreviousHunt()
      .then((previous) => {
        if (cancelled) return;
        setPreviousEvent(previous.events[0] ?? null);
        setNextHunt(previous.next);
        setPreviousLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setPreviousLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [eventsTabVisible, activeLoaded, previousNeeded, previousKey]);

  // Tell the app which full-screen view is open (see onScreenChange). Up here,
  // above the early returns, so the hook order never changes.
  useEffect(() => {
    if (!onScreenChange) return;
    const open =
      selected === "debug-boss-fight" && debugForceBoss
        ? "boss_fight"
        : selected === DEBUG_MERCHANT.id && debugForceMerchant
          ? "merchant"
          : // The previous event too: an ended boss's results stay blacked out.
            (
              events.find((e) => e.id === selected) ??
              (previousEvent?.id === selected ? previousEvent : undefined)
            )?.type;
    onScreenChange(
      open === "boss_fight" ? "boss" : open === "merchant" ? "merchant" : null,
    );
  }, [
    selected,
    events,
    previousEvent,
    debugForceBoss,
    debugForceMerchant,
    onScreenChange,
  ]);

  if (!activeLoaded || !previousLoaded) {
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
  const liveEvents = [
    ...events,
    ...(debugBoss ? [debugBoss] : []),
    ...(debugForceMerchant ? [DEBUG_MERCHANT] : []),
  ];

  if (selected === null) {
    const cards: EventCard[] = [];
    // Older servers don't send `upcoming`, so the hunt falls back to
    // /events/previous-hunt's `next`.
    const nextByType = new Map(upcoming.map((u) => [u.type, u]));
    if (nextHunt && !nextByType.has("song_hunt")) {
      nextByType.set("song_hunt", nextHunt);
    }
    const huntLive = debugForceActive && previousHunt ? previousHunt : null;

    // Every known type always gets a card — live, scheduled, or idle — so the
    // list reads as "what the game has" rather than only what is on now.
    for (const { type } of EVENT_TYPES) {
      const live = liveEvents.filter((e) => e.type === type);
      if (type === "song_hunt" && live.length === 0 && huntLive) {
        live.push(huntLive);
      }
      for (const e of live) {
        const boss =
          e.type === "boss_fight"
            ? (e.config as unknown as BossFightView)
            : null;
        // In Town every event is a visitor, so the card is named for who's
        // here (the boss by its own name) with what they're up to under it.
        cards.push({
          type,
          title: visitorName(type, e.title),
          description: null,
          status: "live",
          at: e.endsAt,
          openKey: type === "song_hunt" ? "song_hunt" : e.id,
          eventId: e.id,
          detail: boss
            ? boss.killed
              ? "Defeated!"
              : `HP ${Math.round(boss.hp)} / ${Math.round(boss.maxHp)}`
            : taglineOf(type),
        });
      }
      if (live.length > 0) continue;

      const next = nextByType.get(type);
      // What the last one left behind: the hunt's answer, or a boss's results
      // for a few days after it went down (or got away).
      let previous: GameEvent | null = null;
      let previousDetail: string | undefined;
      if (type === "song_hunt" && previousHunt) {
        previous = previousHunt;
        previousDetail = "See the last song he was looking for";
      } else if (
        type === "boss_fight" &&
        previousEvent?.type === "boss_fight" &&
        Date.now() - new Date(previousEvent.endsAt).getTime() < 3 * 86_400_000
      ) {
        previous = previousEvent;
        const last = previousEvent.config as unknown as BossFightView;
        previousDetail = last.killed
          ? "Last boss was defeated — see results"
          : "Last boss got away";
      }

      cards.push({
        type,
        title: visitorName(type, next?.title ?? previous?.title),
        description: null,
        status: next ? "scheduled" : "idle",
        at: next?.startsAt ?? null,
        openKey: previous
          ? type === "song_hunt"
            ? "song_hunt"
            : previous.id
          : null,
        eventId: next?.id ?? previous?.id,
        detail:
          previousDetail ??
          (next
            ? "On the way to town"
            : type === "merchant"
              ? "Not in town. Keep an eye out!"
              : "No visit planned yet"),
      });
    }
    // Anything else live (e.g. a secret track) still gets a card.
    for (const e of liveEvents) {
      if (EVENT_TYPES.some((t) => t.type === e.type)) continue;
      cards.push({
        type: e.type,
        title: visitorName(e.type, e.title),
        description: e.description ?? taglineOf(e.type) ?? null,
        status: "live",
        at: e.endsAt,
        openKey: null,
      });
    }
    // Nearest in time first: what's on now, then what starts soonest, then
    // types with nothing on the calendar.
    const when = (c: EventCard) =>
      c.status === "live"
        ? 0
        : c.at
          ? new Date(c.at).getTime()
          : Number.POSITIVE_INFINITY;
    cards.sort(
      (a, b) => when(a) - when(b) || typeRank(a.type) - typeRank(b.type),
    );

    const inTown = cards.filter((c) => c.status === "live").length;
    const nextArrival = cards.find((c) => c.status === "scheduled");

    return (
      <View
        title="Town"
        colour="cyan"
        childrenClassName="flex min-h-0 flex-col"
      >
        {inTown === 0 && (
          // An empty Town reads as dead in a way an empty event list never
          // did, so say it's quiet and who's coming next.
          <div className="mb-2 border border-dashed border-border px-2 py-1.5 text-center text-ui text-text-dim">
            Town is quiet right now.
            {nextArrival?.at ? (
              <>
                {" "}
                <span className="text-text">{nextArrival.title}</span> arrives
                in {formatIn(nextArrival.at)}.
              </>
            ) : null}
          </div>
        )}
        <List className="min-h-0 flex-1">
          <div className="flex flex-col">
            {cards.map((card) => (
              <EventCardRow
                key={`${card.type}-${card.eventId ?? card.status}`}
                card={card}
                paused={!eventsTabVisible || !focused}
                onOpen={
                  card.openKey
                    ? () => setSelected(card.openKey as string)
                    : undefined
                }
              />
            ))}
          </div>
        </List>
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
        action={<BossFightHelp event={selectedEvent} />}
      >
        <BossFightPanel
          event={selectedEvent}
          paused={!eventsTabVisible || !focused}
          equipped={equipped}
        />
      </View>
    );
  }

  if (selectedEvent?.type === "merchant") {
    return (
      <View
        title={MERCHANT_NAME}
        colour="yellow"
        childrenClassName="flex min-h-0 flex-col"
        backButton={
          <BackButton colour="yellow" onClick={() => setSelected(null)} />
        }
        action={formatCountdown(selectedEvent.endsAt)}
      >
        <MerchantPanel
          event={selectedEvent}
          currency={currency}
          equipped={equipped}
          units={units}
          onBought={() => setReloadKey((k) => k + 1)}
          onLog={onLog}
          paused={!eventsTabVisible || !focused}
        />
      </View>
    );
  }

  if (selected !== "song_hunt") {
    // The opened event ended between polls.
    return (
      <View title="Town" colour="cyan" backButton={back}>
        <div className="flex h-full items-center justify-center text-center text-xs text-text-dim">
          They've left town.
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
        title="Song Hunt"
        colour="cyan"
        childrenClassName="flex min-h-0 flex-col"
        backButton={back}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div>
            <h2 className="text-ui-2xl mb-3 font-bold">
              {VISITORS.song_hunt.name}{" "}
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
                ? `Arrives in town in ${formatStartsIn(nextStartsAt)}.`
                : "Not in town, and no visit planned yet."}
            </div>
          </div>

          {previousHunt ? (
            <div className="mt-4 flex min-h-0 flex-1 flex-col border-t border-border pt-4">
              <h2 className="text-ui-lg mb-3 font-bold">
                Last visit{" "}
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
                    <h2 className="text-ui font-bold text-text-dim">
                      The song he was looking for:
                    </h2>
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
                      <div
                        className="flex items-center gap-1 text-ui"
                        // Inspect grows the card out of this icon.
                        {...{ [INSPECT_ORIGIN_ATTR]: "hunt-reward" }}
                      >
                        <ItemTypeIcon
                          item={previousRewardItem}
                          className="h-6 w-6 shrink-0"
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
                          Nobody found it for him last time.
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
            origin={inspectOrigin("hunt-reward")}
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
          {VISITORS.song_hunt.name} isn't in town. Check back later!
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

  return (
    <View
      title="Song Hunt"
      colour="cyan"
      childrenClassName="flex flex-col h-full"
      backButton={back}
      action={
        <VisitorHelp
          label="What is a song hunt?"
          colour={VISITOR_THEMES.song_hunt.accent}
          text={`${VISITORS.song_hunt.name} is looking for a song. Work it out from the clues and play it — the first ${config.maxClaims} to find it get a reward.`}
          rewards={[
            {
              label: "Reward",
              itemId: config.rewardItemId,
              note: `${config.maxClaims - config.firstFinders.length} left`,
            },
          ]}
        />
      }
    >
      <OrphiezStage paused={!eventsTabVisible || !focused} />
      {hunt.description ? (
        <div className="mt-1 shrink-0 text-center text-ui text-text-dim">
          {hunt.description}
        </div>
      ) : null}

      {/* mt-auto sinks the tabs and their list to the bottom, so a short
          list leaves its slack above the tabs instead of under the list. */}
      <div className="mt-auto flex shrink-0 gap-1 border-b border-border pt-2 text-ui">
        <TabButton
          active={huntTab === "clues"}
          onClick={() => setHuntTab("clues")}
        >
          Clues
        </TabButton>
        <TabButton
          active={huntTab === "finders"}
          onClick={() => setHuntTab("finders")}
        >
          Finders ({config.firstFinders.length})
        </TabButton>
      </div>

      {/* No flex-1: the box is only as tall as the clues, and scrolls once
          they'd push past the window. The clues always lay out (just hidden
          on the Finders tab) and the finders sit over them at the same
          height, scrolling if they run longer — so switching tabs never
          moves the tab row. */}
      <div className="mt-2 min-h-0 cursor-default overflow-y-auto">
        <div className="relative">
          <div className={huntTab === "clues" ? undefined : "invisible"}>
            {config.hints.map((hint, i) => (
              <div
                key={hint.unlocksAt}
                className={cn(
                  "py-1",
                  i < config.hints.length - 1 && "mb-1 border-b border-border",
                )}
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
          {huntTab === "finders" && (
            <div className="absolute inset-0 flex flex-col">
              {config.firstFinders.length > 0 ? (
                <List className="min-h-0 flex-1">
                  {config.firstFinders.map((finder, i) => (
                    <div
                      key={`${finder.name}-${finder.claimedAt}`}
                      className="mb-1 flex justify-between border-b border-border py-1 text-ui last:mb-0 last:border-b-0"
                    >
                      <span className={i === 0 ? "text-yellow" : "text-text"}>
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
                  Nobody has found it for him yet...
                </div>
              )}
            </div>
          )}
        </div>
      </div>

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

/** A row styled like ItemRow (the inventory/store lists): name over a small
 * dim subtitle, with the status and countdown on the right. */
function EventCardRow({
  card,
  onOpen,
  paused,
}: {
  card: EventCard;
  onOpen?: () => void;
  /** Tab hidden or window unfocused — freeze the sparkles. */
  paused: boolean;
}) {
  const subtitle = card.description ?? card.detail;
  const live = card.status === "live";
  // Only a visitor who's actually in town wears their theme.
  const theme = live ? VISITOR_THEMES[card.type] : undefined;
  const dim = theme ? { color: theme.dim } : undefined;

  const left = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <VisitorIcon
        type={card.type}
        seed={card.eventId}
        inTown={live}
        className="h-6 w-6 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-ui",
            theme ? "text-white" : "text-text",
            // Only a row that opens something reacts to hover.
            !theme && onOpen && "group-hover:text-cyan",
          )}
        >
          {card.title}
        </div>
        {subtitle ? (
          <div className="truncate text-[10px] text-text-dim" style={dim}>
            {subtitle}
          </div>
        ) : null}
      </div>
    </div>
  );

  // The whole row is the click target when it opens something, padding
  // included — a button nested inside left the row's top and bottom edges
  // (and the status column) dead.
  const Row = onOpen ? "button" : "div";

  return (
    <Row
      {...(onOpen ? { type: "button" as const, onClick: onOpen } : {})}
      className={cn(
        "group relative flex w-full items-center justify-between gap-2 overflow-hidden text-left",
        "border-b border-[#222] py-1.5",
        onOpen && "cursor-pointer",
        theme && "pr-2",
        // Live at full strength; scheduled a little dimmer; nothing-on dimmer
        // still.
        card.status === "scheduled" && "opacity-65",
        card.status === "idle" && "opacity-50",
      )}
      style={theme ? { textShadow: ROW_TEXT_SHADOW } : undefined}
    >
      {theme && (
        // The Now Playing card's backdrop treatment (see TrackCard): the
        // visitor's colours fill the right half and fade into the app
        // background toward the left, sparkles and all.
        <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 overflow-hidden">
          {/* Hover brightens only the colour, never the fade on top of it:
              a filter on the whole row lit up the fade's bg-panel edge
              into a visible box. */}
          <div
            className={cn(
              "absolute inset-0",
              onOpen &&
                "transition-[filter] duration-100 group-hover:brightness-150",
            )}
            style={{ background: theme.background }}
          />
          {theme.sparkle && (
            <VisitorSparkles sparkle={theme.sparkle} paused={paused} />
          )}
          <div className="absolute inset-0 bg-gradient-to-r from-bg-panel to-transparent" />
        </div>
      )}
      <div className="relative flex min-w-0 flex-1">{left}</div>
      <div className="relative shrink-0 text-right">
        {live ? (
          <div
            className="text-[10px] font-bold text-green"
            style={theme ? { color: theme.accent } : undefined}
          >
            IN TOWN
          </div>
        ) : null}
        {card.at ? (
          <div className="text-[10px] text-text-dim" style={dim}>
            {!live
              ? `in ${formatIn(card.at)}`
              : // Every visitor leaves when their visit ends.
                `leaving in ${formatIn(card.at)}`}
          </div>
        ) : null}
      </div>
    </Row>
  );
}

/** Memoized: mounted (hidden) for the app's whole life, so without this it
 * re-rendered on every App render, i.e. every state push. Its props are all
 * identity-stable while unchanged (see stableMerge in main.tsx). */
export const EventsView = memo(EventsViewImpl);
