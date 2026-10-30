import "./globals.css";
import {
  bankCapacity,
  basicAttack,
  CLASS_DEFS,
  getHerzieStatsFromUnits,
  type HerzieClass,
  type HerzieProfile,
  hasInstrument,
  hasRoomFor,
  instrumentOf,
  isBankFull,
  levelProgress,
  needsClassChoice,
  SH,
  statPoints,
} from "@herzies/shared";
import { herzieStage } from "@herzies/shared/gl";
import { attachConsole } from "@tauri-apps/plugin-log";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatPanel } from "./components/ChatPanel";
import {
  ClassChoiceOverlay,
  withClassGear,
} from "./components/ClassChoiceOverlay";
import { EventsView } from "./components/EventsView";
import { FriendsView } from "./components/FriendsView";
import {
  HERZIE_STAGE_HEIGHT,
  HerzieWithSky,
  HomeSky,
  STAGE_FLOOR_INSET,
} from "./components/HerzieWithSky";
import { HomeView } from "./components/HomeView";
import { IncomingFriendOverlay } from "./components/IncomingFriendOverlay";
import { IncomingTradeOverlay } from "./components/IncomingTradeOverlay";
import { InventoryView } from "./components/InventoryView";
import { LeaderboardView } from "./components/LeaderboardView";
import { LoadingSplash } from "./components/LoadingSplash";
import { Notices } from "./components/Notices";
import { OnboardingScreen } from "./components/OnboardingScreen";
import { OverlayWindow } from "./components/OverlayWindow";
import { ProfileView } from "./components/ProfileView";
import { PromptOverlay } from "./components/PromptOverlay";
import { SettingsView } from "./components/SettingsView";
import { SkillsPanel } from "./components/SkillsPanel";
import { SplashScreen } from "./components/SplashScreen";
import { StatsTab } from "./components/StatsTab";
import { StoreView } from "./components/StoreView";
import { type MenuLanding, TabBar, type View } from "./components/TabBar";
import { TradeView } from "./components/TradeView";
import { BULLETIN_KEY } from "./components/town/Boards";
import { setLootRoom } from "./components/town/combat/lootFeed";
import { useBossResultsShown } from "./components/town/combat/results";
import { setArmed, setMySkills } from "./components/town/combat/skills";
import { combat } from "./components/town/combat/state";
import { homeDropFeed } from "./components/town/dropSpots";
import { homeMode, useHomeMode } from "./components/town/homeMode";
import { townNet } from "./components/town/net/townNet";
import {
  canExpandTown,
  toggleTownExpanded,
  useTownExpanded,
} from "./components/town/townWindow";
import { UpdateAvailableOverlay } from "./components/UpdateAvailableOverlay";
import { WhatsNewOverlay } from "./components/WhatsNewOverlay";
import { useOptimisticUnits } from "./hooks/useOptimisticUnits";
import { useHomeStageOffset } from "./hooks/useStageAlignment";
import { useTradeRequests } from "./hooks/useTradeRequests";
import { onLogActivity } from "./lib/activity";
import { notify } from "./lib/notices";
import { stableMerge } from "./lib/stableMerge";
import { cn } from "./lib/utils";
import { RELEASE_NOTES } from "./release-notes";
import {
  type AppState,
  checkForUpdate,
  downloadUpdate,
  herzies,
  installUpdate,
  type UpdateInstallEvent,
  useGhostMode,
  useWindowFocused,
} from "./tauri-bridge";

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h

const WHATS_NEW_SEEN_KEY = "herzies:whats-new-seen-version";

/** The screens the app sits on: Home and the Town. Everything else opens as
 * an overlay window over one of them. */
type Base = "home" | "events";
type OverlayId = Exclude<View, Base>;
/** The camera on Home with the deck or the bag open: pulled back, so the
 * herzie fits above the window. */
const HOME_INVENTORY_ZOOM = 0.8;
/** ...eased there slowly enough to see it, about as long as the raise
 * (HOME_INVENTORY_RAISE_MS). */
const HOME_INVENTORY_ZOOM_EASE = 0.1;
const HOME_INVENTORY_RAISE_MS = 340;
/** How tall Home's own herzie view is drawn (HerzieView's box at size 5):
 * the Town frames Home's herzie the same size (see town/homeCamera). */
const HOME_VIEW_HEIGHT = Math.ceil(SH * 5 * 1.35);
/** The small window's height (tauri.conf.json): Home's herzie is drawn as
 * big for a bigger window as it is for this one. */
const SMALL_WINDOW_HEIGHT = 520;
/** In the big window: where the herzie's feet stand (a fraction of the
 * window's height down), and the most it's drawn bigger. */
const HOME_BIG_FEET = 0.72;
const HOME_BIG_MAX_ZOOM = 1.6;
/** How long Home's stand-in herzie takes to give way to the world's. */
const HOME_STAND_IN_FADE_MS = 450;
/** How long Home's sky stays after leaving, under the world fading back
 * in over it. */
const HOME_SKY_LINGER_MS = 900;

/** `on`, held on for `ms` after it goes off. */
function useLinger(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(on);
  useEffect(() => {
    if (on) {
      setHeld(true);
      return;
    }
    const t = setTimeout(() => setHeld(false), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return on || held;
}

/** The app window's height, kept current. */
function useWindowHeight() {
  const [height, setHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const update = () => setHeight(window.innerHeight);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return height;
}

/** The Herzie window's tabs. */
type HerzieTab = "deck" | "bag" | "stats" | "skills";
/** A class's name, for the player card ("Bard"); none without a class. */
const classLabelOf = (c: HerzieClass | null | undefined) =>
  c ? CLASS_DEFS[c].name : undefined;
const isBase = (v: View): v is Base => v === "home" || v === "events";

type UpdateInstallStatus =
  | { kind: "idle" }
  | { kind: "installing"; downloaded: number; total: number | undefined }
  | { kind: "error"; message: string };

/** Every herzie is drawn on one shared canvas (see herzieStage); it goes
 * inside the app's root, so it stacks under the app's overlays and takes
 * its filters (ghost mode's grey). */
function hostHerzies(el: HTMLDivElement | null) {
  herzieStage.setHost(el);
}

/** Publishes the dock's (the chat's) height as `--dock-height`, for
 * whatever floats above it over the Town (the "Talk to" prompt). */
const dockObserver = new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty(
    "--dock-height",
    `${(entry.target as HTMLElement).offsetHeight}px`,
  );
});
function observeDock(el: HTMLDivElement | null) {
  dockObserver.disconnect();
  // The border box: going into the Town only changes the dock's padding,
  // which the default (content box) wouldn't notice.
  if (el) dockObserver.observe(el, { box: "border-box" });
}

function App() {
  const endScreenUp = useBossResultsShown() !== null;
  const [rawState, setState] = useState<AppState>({
    herzie: null,
    nowPlaying: null,
    multipliers: null,
    isOnline: false,
    isConnected: true,
    version: "",
    equipped: {},
    chatMessages: [],
    inventory: null,
    inventoryCurrency: 0,
    itemUpgrades: {},
    units: [],
    bankExpansions: 0,
    skills: [],
    friends: {},
    pendingTradeRequest: null,
    pendingFriendRequest: null,
    incomingFriendRequests: [],
    outgoingFriendRequests: [],
    pendingDrops: [],
    loggingIn: false,
  });
  /** False until the first state arrives from the backend; the placeholder
   * above would otherwise flash the logged-out splash on every launch. */
  const [hydrated, setHydrated] = useState(false);
  // Equipping, selling and dice upgrades are predicted locally so they land
  // instantly (see useOptimisticUnits). Overlaying the result onto `state` here,
  // rather than threading it to each consumer, is what keeps the 3D herzie, the
  // deck row, the bank grid and the "inventory full" check from disagreeing for
  // a frame.
  const {
    equipped: effectiveEquipped,
    units: effectiveUnits,
    predictedInventory,
    toggleEquip,
    predict,
  } = useOptimisticUnits(
    rawState.equipped,
    rawState.units,
    rawState.herzie?.stage ?? 1,
    rawState.herzie?.class ?? null,
  );
  // Memoized on its inputs, each of which is itself identity-stable while its
  // content is unchanged (`rawState` via stableMerge, field by field) — so this
  // object only changes when something really did, and an unrelated App
  // re-render (a view switch, a local toggle) doesn't hand every view a new
  // `state` and re-render the lot.
  //
  // `inventory` (the counts) follows the predicted copies only while something
  // is predicted: otherwise it stays the server's own, which is all there is to
  // show before copies have arrived (e.g. a cache from before they existed).
  const state = useMemo(
    () => ({
      ...rawState,
      equipped: effectiveEquipped,
      units: effectiveUnits,
      inventory: predictedInventory ?? rawState.inventory,
    }),
    [rawState, effectiveEquipped, effectiveUnits, predictedInventory],
  );
  // Mounted here, at the root, rather than inside a view: trade invites have to
  // keep arriving while the window is hidden, and every view below is unmounted
  // or hidden at some point. See the hook for why the Rust-side fallback poll
  // stays.
  useTradeRequests(rawState.isOnline);
  // Home is where the app opens; the Town is the other screen. Herzie,
  // Social, Premium, Settings and a trade open over either as a window.
  const [base, setBase] = useState<Base>("home");
  const [overlay, setOverlay] = useState<OverlayId | null>(null);
  /** What the nav shows as selected. */
  const view: View = overlay ?? base;
  // Home is a way of looking at the Town (town/homeMode): the world, once
  // it's up, is what Home shows; until then (or without it) Home's own
  // stand-in does.
  const { ready: homeInWorld, combatMap } = useHomeMode();
  useEffect(() => {
    homeMode.set(base === "home");
  }, [base]);
  // A window over Home has the keys: nobody walks off.
  useEffect(() => {
    homeMode.setLocked(overlay !== null);
  }, [overlay]);
  /** Home in the big window (see setView): only once Home's in the world. */
  const [homeBigWanted, setHomeBig] = useState(false);
  const homeBig = base === "home" && homeInWorld && homeBigWanted;
  /** Whether the window's big right now, for setView (set where it's
   * worked out, below). */
  const bigWindowRef = useRef(false);
  /** No Home to go to from an island you fight on. */
  const homeBlocked = base === "events" && combatMap;
  /** Home's own herzie, standing in until the world's is up (and fading
   * out from under it after). */
  const standInShown = useLinger(!homeInWorld, HOME_STAND_IN_FADE_MS);
  /** Home's sky, once Home's in the world: at Home, and a moment after. */
  const homeSkyShown = useLinger(
    homeInWorld && base === "home",
    HOME_SKY_LINGER_MS,
  );
  // The window that was just closed (or swapped for another) stays "shown"
  // until its exit has played: its content keeps still under the fade.
  const [leavingOverlay, setLeavingOverlay] = useState<OverlayId | null>(null);
  const [prevOverlay, setPrevOverlay] = useState<OverlayId | null>(overlay);
  /** Deck, Bag, Stats and Skills are one window's tabs: switching between
   * them isn't leaving it. */
  const isInventory = (v: View | null): v is HerzieTab =>
    v === "deck" || v === "bag" || v === "stats" || v === "skills";
  if (prevOverlay !== overlay) {
    setPrevOverlay(overlay);
    if (prevOverlay && !(isInventory(prevOverlay) && isInventory(overlay))) {
      setLeavingOverlay(prevOverlay);
    }
  }
  /** The deck-and-bag window's tab: the one asked for last. */
  const [inventoryPanel, setInventoryPanel] = useState<HerzieTab>("deck");
  if (isInventory(overlay) && overlay !== inventoryPanel) {
    setInventoryPanel(overlay);
  }
  /** A window is on screen: open, or still fading out. */
  const windowShown = (id: OverlayId) =>
    overlay === id || leavingOverlay === id;
  const windowClosed = (id: OverlayId) => () =>
    setLeavingOverlay((l) => (l === id ? null : l));
  /** Go straight to `v`: a base closes any window; a window opens over the
   * current base. (switchView is the guarded, toggling version.) */
  const setView = useCallback((v: View) => {
    if (isBase(v)) {
      // Home from the Town's big window stays big (Home's shown in the same
      // world); otherwise Home's the small window it always was.
      if (v === "home") setHomeBig(bigWindowRef.current);
      setBase(v);
      setOverlay(null);
    } else setOverlay(v);
  }, []);
  // Bumped when the player re-selects the tab they're already on (click or
  // shortcut), so a view that's drilled into a sub-screen — Town → George,
  // Social → a profile — goes back to its top level.
  const [rootKeys, setRootKeys] = useState<Partial<Record<View, number>>>({});
  /** The Menu tab's tray of windows (TabBar). */
  const [menuOpen, setMenuOpen] = useState(false);
  /** A card flew to the menu's Deck or Bag (see InventoryView). */
  const [menuLanding, setMenuLanding] = useState<MenuLanding | null>(null);
  const onTabLanded = useCallback(
    (panel: "deck" | "bag") =>
      setMenuLanding((l) => ({ panel, n: (l?.n ?? 0) + 1 })),
    [],
  );
  // The deck and bag draw into their window (InventoryView portals them).
  const [inventorySlot, setInventorySlot] = useState<HTMLDivElement | null>(
    null,
  );
  const [tradeTarget, setTradeTarget] = useState<string | null>(null);
  const [incomingTradeId, setIncomingTradeId] = useState<string | null>(null);
  const [activityLog, setActivityLog] = useState<
    { time: string; message: string }[]
  >([]);
  const [deepLinkItem, setDeepLinkItem] = useState<string | null>(null);
  const [stageOverride, setStageOverride] = useState<number | null>(null);
  const [previewOnboarding, setPreviewOnboarding] = useState(false);
  /** Debug: hold the loading splash up until Escape. */
  const [previewLoading, setPreviewLoading] = useState(false);
  useEffect(() => {
    if (!previewLoading) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewLoading(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewLoading]);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  /** Version the user dismissed the update overlay for; suppresses re-showing it. */
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<
    string | null
  >(null);
  /** Dev-only: shows the update overlay with a fake version (Settings → Debug). */
  const [testUpdateOverlay, setTestUpdateOverlay] = useState(false);
  /** Version to show the "What's new" overlay for; null means hidden. */
  const [whatsNewVersion, setWhatsNewVersion] = useState<string | null>(null);
  /** Dev-only: shows the "What's new" overlay with sample notes (Settings → Debug). */
  const [testWhatsNewOverlay, setTestWhatsNewOverlay] = useState(false);
  /** Dev-only: draws the herzie holding a class's gear (Settings → Debug). */
  const [classOverride, setClassOverride] = useState<HerzieClass | null>(null);
  /** Dev-only: opens the class choice whatever the herzie's state. */
  const [testClassChoice, setTestClassChoice] = useState(false);
  // The Town's skill bar follows the class skills the app knows about —
  // or, under a Class Preview, that class's skills at Lv. 1 (practice on
  // the training grounds works; the cave's server refuses them).
  useEffect(() => {
    const cls = classOverride ?? rawState.herzie?.class;
    setMySkills(
      classOverride
        ? CLASS_DEFS[classOverride].skills.map((skillId) => ({
            skillId,
            level: 1,
          }))
        : rawState.skills,
      cls ? CLASS_DEFS[cls].skills : [],
    );
  }, [rawState.skills, rawState.herzie?.class, classOverride]);
  // How the Town's basic attack goes: by class and the instrument in hand
  // (a Record Slinger throws its discs; without them, a punch or a body
  // slam). A Class Preview draws its class's gear, so it plays it.
  const mainHand = classOverride
    ? instrumentOf(classOverride)
    : (effectiveEquipped.main_hand ?? null);
  const attackCls = classOverride ?? rawState.herzie?.class ?? null;
  const attackStage = stageOverride ?? rawState.herzie?.stage ?? 1;
  useEffect(() => {
    const a = basicAttack({ cls: attackCls, stage: attackStage, mainHand });
    combat.attack = a.style;
    combat.blow = a.blow;
    setArmed(hasInstrument(attackCls, mainHand), instrumentOf(attackCls));
  }, [attackCls, attackStage, mainHand]);
  // A new class, level or instrument: the Town server judges casts from the
  // ticket (a class's attack, the instrument it needs; the Tower's level
  // gap), so it gets a fresh one. After a beat, so the server has the
  // change saved.
  const ticketKey = `${rawState.herzie?.class ?? ""}|${rawState.herzie?.level ?? 0}|${rawState.equipped.main_hand ?? ""}`;
  const firstTicketKey = useRef(ticketKey);
  useEffect(() => {
    if (firstTicketKey.current === ticketKey) return;
    firstTicketKey.current = ticketKey;
    const t = setTimeout(() => void townNet().refreshLook(), 1_500);
    return () => clearTimeout(t);
  }, [ticketKey]);
  /** "Later" on the class choice: asked again next launch. */
  const [classChoiceLater, setClassChoiceLater] = useState(false);
  /** Captured the first time `state.isOnline` is true this session: was this
   * device mid-onboarding (no herzie yet)? A fresh install or reinstall
   * shouldn't be told what's new in the version it just installed — only an
   * existing user upgrading into a version with curated notes should. */
  const isFreshInstallRef = useRef<boolean | null>(null);
  const [updateInstallStatus, setUpdateInstallStatus] =
    useState<UpdateInstallStatus>({ kind: "idle" });
  /** Set by the "c" shortcut: focus/expand the chat once the home view shows it. */
  const [openChatRequested, setOpenChatRequested] = useState(false);
  /** "c" pressed mid-trade: open chat after the user confirms leaving the trade. */
  const openChatAfterLeaveRef = useRef(false);
  /** Events on right now — the nav's Events button sparkles and counts
   * them. */
  const [eventsRunning, setEventsRunning] = useState(0);
  /** A screen for EventsView to open, or null to close it: see its
   * openRequest. */
  const [townOpen, setTownOpen] = useState<{
    key: string | null;
    n: number;
  } | null>(null);
  const requestScreen = useCallback(
    (key: string | null) => setTownOpen((r) => ({ key, n: (r?.n ?? 0) + 1 })),
    [],
  );
  /** The screen EventsView has open (the bulletin board, a visitor), over
   * Home or the Town. */
  const [eventsPanel, setEventsPanel] = useState<string | null>(null);
  /** Where that panel goes: in the app's root, outside the Town's view. */
  const [panelHost, setPanelHost] = useState<HTMLDivElement | null>(null);
  const [hasActiveEventOverride, setHasActiveEventOverride] = useState(false);
  const [debugBossOverride, setDebugBossOverride] = useState(false);
  const [debugMerchantOverride, setDebugMerchantOverride] = useState(false);
  const [debugTreatTraderOverride, setDebugTreatTraderOverride] =
    useState(false);
  /** Which full-screen event view the Events tab has open, if any. */
  const [eventsScreen, setEventsScreen] = useState<
    "boss" | "merchant" | "world" | "visitor" | null
  >(null);
  const [chatProfileCode, setChatProfileCode] = useState<string | null>(null);
  /** Where Back on an opened profile goes, if not just the Social tab: set
   * when a profile is opened from the Town. */
  const [profileReturn, setProfileReturn] = useState<View | null>(null);
  const [selfProfile, setSelfProfile] = useState<HerzieProfile | null>(null);
  const [ignoredIncomingTradeId, setIgnoredIncomingTradeId] = useState<
    string | null
  >(null);
  const [incomingTradeDeclineBusy, setIncomingTradeDeclineBusy] =
    useState(false);
  const [ignoredFriendRequestId, setIgnoredFriendRequestId] = useState<
    string | null
  >(null);
  const [friendOverlayBusy, setFriendOverlayBusy] = useState<
    "accept" | "decline" | null
  >(null);
  const [friendsTab, setFriendsTab] = useState<
    "friends" | "requests" | "add" | "trades"
  >("friends");
  /** Bumps when a trade session ends or a new one starts so TradeView remounts (clears stale tradeId). */
  const [tradeViewGeneration, setTradeViewGeneration] = useState(0);
  /** True while TradeView has a live (non-terminal) trade open. */
  const [tradeActive, setTradeActive] = useState(false);
  /** Set when the user tries to navigate away mid-trade; holds the destination until confirmed. */
  const [pendingLeaveView, setPendingLeaveView] = useState<View | null>(null);
  /** True once the "inventory full" alert has been dismissed for the current
   * overflow — reset the moment a slot frees up, so filling back up again
   * (a further buy/pickup) shows it again instead of staying silenced. */
  const [dismissedInventoryFull, setDismissedInventoryFull] = useState(false);
  /** Where to return when the trade session ends — the view the user was on before entering it. */
  const tradeReturnViewRef = useRef<OverlayId | null>(null);
  /** The open window, readable from effect closures (deep-link handler). */
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;

  /** Snapshot the open window (Social, say) so closing the trade can return
   * to it; none, and closing it shows the screen underneath. */
  const rememberTradeReturnView = useCallback(() => {
    if (overlayRef.current !== "trade") {
      tradeReturnViewRef.current = overlayRef.current;
    }
  }, []);
  const notifiedVersionRef = useRef<string | null>(null);
  /** Version whose bytes a background downloadUpdate() call has finished for. */
  const downloadedVersionRef = useRef<string | null>(null);
  /** In-flight background download, so installUpdate can await it instead of
   * racing a second download of the same Update instance. */
  const pendingDownloadRef = useRef<{
    version: string;
    promise: Promise<void>;
  } | null>(null);
  const focused = useWindowFocused();
  const ghostMode = useGhostMode();

  // The cave's loot asks the bank before picking up, as Home's drops do.
  useEffect(() => {
    const capacity = bankCapacity(state.bankExpansions);
    setLootRoom((itemId) =>
      hasRoomFor(state.inventory, state.equipped, itemId, capacity),
    );
  }, [state.inventory, state.equipped, state.bankExpansions]);
  // What's lying on the ground, for the world to put round your herzie
  // (town/HomeDrops).
  useEffect(() => {
    homeDropFeed.set(state.pendingDrops ?? []);
  }, [state.pendingDrops]);

  const addLog = useCallback((message: string) => {
    const time = new Date().toISOString();
    setActivityLog((prev) => [...prev.slice(-49), { time, message }]);
  }, []);

  useEffect(() => {
    // Merged rather than replaced: see stableMerge for why identity matters.
    const applyState = (next: AppState) =>
      setState((prev) => stableMerge(prev, next));
    herzies.getState().then((next) => {
      applyState(next);
      setHydrated(true);
    });
    const unlistenState = herzies.onStateUpdate(applyState);
    // What the backend says happened (a pickup, a friend, a visitor, a level
    // up): into the log, and over the screen for a moment.
    const unlistenActivity = herzies.onActivity((message) => {
      addLog(message);
      notify(message, { kind: "info" });
    });
    const unlistenLog = onLogActivity(addLog);
    const unlistenDeepLink = herzies.onDeepLink((payload) => {
      if (payload.startsWith("trade:")) {
        const tradeId = payload.slice("trade:".length);
        rememberTradeReturnView();
        setTradeViewGeneration((g) => g + 1);
        setIncomingTradeId(tradeId);
        setTradeTarget(null);
        setView("trade");
      } else if (payload === "friends:requests") {
        setFriendsTab("requests");
        setView("friends");
      } else if (payload === "events") {
        setView("events");
      } else {
        setDeepLinkItem(payload);
        setView("bag");
      }
    });
    return () => {
      unlistenState();
      unlistenActivity();
      unlistenLog();
      unlistenDeepLink();
    };
  }, [addLog, rememberTradeReturnView, setView]);

  useEffect(() => {
    if (!state.pendingTradeRequest) {
      setIgnoredIncomingTradeId(null);
      setIncomingTradeDeclineBusy(false);
    }
  }, [state.pendingTradeRequest]);

  useEffect(() => {
    if (!state.pendingFriendRequest) {
      setIgnoredFriendRequestId(null);
      setFriendOverlayBusy(null);
    }
  }, [state.pendingFriendRequest]);

  const inventoryFull = isBankFull(
    state.inventory,
    state.equipped,
    bankCapacity(state.bankExpansions),
  );
  useEffect(() => {
    if (!inventoryFull) setDismissedInventoryFull(false);
  }, [inventoryFull]);

  // Recolour the window while a live boss (blackout) or George (deep gold) is
  // open. The class goes on <html> rather than a React element because the
  // app's root div is transparent — body's bg-bg-panel is what you actually
  // see, and it also covers the window's corners and any area the root
  // doesn't paint. CSS owns the fade so both directions are symmetric.
  useEffect(() => {
    const onEvents = base === "events";
    const root = document.documentElement.classList;
    root.toggle("boss-mode", onEvents && eventsScreen === "boss");
    root.toggle("merchant-mode", onEvents && eventsScreen === "merchant");
    return () => root.remove("boss-mode", "merchant-mode");
  }, [base, eventsScreen]);

  // The tab only needs to know whether a song hunt is running right now, which
  // /events-active alone answers — and it's an Edge Function, so it's cheap and
  // fast. This used to also fetch /events/previous-hunt (a slow Vercel route)
  // purely "for parity with EventsView" and discard the result.
  const refreshEventIndicator = useCallback(() => {
    herzies
      .fetchActiveEvents()
      .then(({ events }) => {
        // Not the monthly Tower: it's always on, so it would keep the
        // button sparkling all month.
        setEventsRunning(events.filter((e) => e.type !== "tower").length);
      })
      .catch(() => {
        setEventsRunning(0);
      });
  }, []);

  // CSS keyframe loops (marquees, floating drops) can't read the hook, so
  // flag the root and let globals.css pause them while the window is blurred.
  useEffect(() => {
    document.documentElement.toggleAttribute("data-window-blurred", !focused);
  }, [focused]);

  // One effect, not two: a second copy gated on `state.isOnline` alone fired a
  // duplicate of this every time connectivity flipped while the window was
  // open, which is part of why opening the tray produced a burst of identical
  // requests.
  useEffect(() => {
    if (!focused || !state.isOnline) return;
    refreshEventIndicator();
    const interval = setInterval(refreshEventIndicator, 60_000);
    return () => clearInterval(interval);
  }, [focused, state.isOnline, refreshEventIndicator]);

  // Reset to home screen when logging back in
  const prevOnline = useRef(state.isOnline);
  useEffect(() => {
    if (state.isOnline && !prevOnline.current) {
      setView("home");
    }
    prevOnline.current = state.isOnline;
  }, [state.isOnline, setView]);

  // Check for updates on launch and every hour. Fires a system notification
  // once per detected version so the user knows even if the window is hidden;
  // an in-app overlay (same style as trade prompts) shows when it's visible.
  // Also silently downloads the update's bytes in the background so that
  // clicking "Update now" later can skip straight to install.
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const update = await checkForUpdate();
      if (cancelled) return;
      if (!update) {
        setAvailableUpdate(null);
        downloadedVersionRef.current = null;
        pendingDownloadRef.current = null;
        return;
      }

      // Once a version is being tracked (downloaded or downloading), ignore
      // this tick's fresh Update instance — swapping it in would orphan the
      // original instance's downloaded bytes, since install() only works on
      // the exact instance download() was called on.
      if (
        downloadedVersionRef.current === update.version ||
        pendingDownloadRef.current?.version === update.version
      ) {
        return;
      }

      setAvailableUpdate(update);
      const version = update.version;
      const promise = downloadUpdate(update)
        .then(() => {
          downloadedVersionRef.current = version;
        })
        .catch((err) => {
          console.warn("Background update download failed:", err);
        })
        .finally(() => {
          if (pendingDownloadRef.current?.version === version) {
            pendingDownloadRef.current = null;
          }
        });
      pendingDownloadRef.current = { version, promise };

      if (notifiedVersionRef.current === update.version) return;
      notifiedVersionRef.current = update.version;

      const granted =
        (await isPermissionGranted()) ||
        (await requestPermission()) === "granted";
      if (granted) {
        sendNotification({
          title: "Herzies update available",
          body: `Version ${update.version} is ready to install. Open Settings to update.`,
        });
      }
    };

    run();
    const id = setInterval(run, UPDATE_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  /** Shared by the update overlay and Settings so either entry point downloads,
   * installs, and relaunches without extra clicks. */
  const handleInstallUpdate = useCallback(async () => {
    if (!availableUpdate) return;
    setUpdateInstallStatus({
      kind: "installing",
      downloaded: 0,
      total: undefined,
    });
    try {
      // If a background download for this version is still in flight, ride
      // it instead of kicking off a second, racing download.
      if (pendingDownloadRef.current?.version === availableUpdate.version) {
        await pendingDownloadRef.current.promise;
      }
      const predownloaded =
        downloadedVersionRef.current === availableUpdate.version;
      await installUpdate(
        availableUpdate,
        (e: UpdateInstallEvent) => {
          if (e.kind === "started") {
            setUpdateInstallStatus({
              kind: "installing",
              downloaded: 0,
              total: e.contentLength,
            });
          } else if (e.kind === "progress") {
            setUpdateInstallStatus({
              kind: "installing",
              downloaded: e.downloaded,
              total: e.total,
            });
          }
        },
        predownloaded,
      );
      // Normally unreachable: installUpdate relaunches the app on success.
      setUpdateInstallStatus({ kind: "idle" });
      setAvailableUpdate(null);
    } catch (err) {
      setUpdateInstallStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [availableUpdate]);

  const { herzie } = state;

  // Surface curated release notes once per version, but only to a device that
  // was already onboarded the first time we saw it this session — a fresh
  // install shouldn't be told what's new in the version it just installed.
  // The seen-version is only persisted from the overlay's own close handler
  // (below), not here: this app can launch hidden, and detecting a version
  // isn't the same as the overlay having actually been shown.
  useEffect(() => {
    if (!state.isOnline) return;
    if (isFreshInstallRef.current === null) {
      isFreshInstallRef.current = !herzie;
    }
    if (isFreshInstallRef.current) {
      if (herzie && localStorage.getItem(WHATS_NEW_SEEN_KEY) === null) {
        localStorage.setItem(WHATS_NEW_SEEN_KEY, state.version);
      }
      return;
    }
    if (!herzie || !state.version) return;
    if (localStorage.getItem(WHATS_NEW_SEEN_KEY) === state.version) return;
    if (RELEASE_NOTES.some((entry) => entry.version === state.version)) {
      setWhatsNewVersion(state.version);
    }
  }, [state.isOnline, state.version, herzie]);

  const switchView = useCallback(
    (v: View, toggle = false): boolean => {
      // Its window again, from its tab or shortcut (`toggle`): close it.
      const closing = toggle && !isBase(v) && v === overlay;
      // Leaving an in-progress trade needs confirmation. The trade itself stays
      // open server-side and can be rejoined from Social → Trades.
      if (overlay === "trade" && (v !== "trade" || closing) && tradeActive) {
        setPendingLeaveView(closing ? base : v);
        return false;
      }
      setMenuOpen(false);
      if (v !== "bag") setDeepLinkItem(null);
      if (v !== "trade") {
        setIncomingTradeId(null);
        setTradeTarget(null);
      }
      // Moving on from the profile: Back no longer goes anywhere special.
      if (v !== "friends") setProfileReturn(null);
      if (closing) {
        setOverlay(null);
        return true;
      }
      if (isBase(v) ? v === base && !overlay : v === overlay) {
        setRootKeys((keys) => ({ ...keys, [v]: (keys[v] ?? 0) + 1 }));
      }
      setView(v);
      return true;
    },
    [base, overlay, tradeActive, setView],
  );

  // Walking off at Home: out into the Town.
  useEffect(
    () => homeMode.onExitRequest(() => switchView("events")),
    [switchView],
  );

  /** "c" shortcut: go home and focus the chat. Mid-trade this routes through
   * the leave-trade confirmation like every other view switch. */
  /** The Town's 3D world is on screen: it fills the window, and the chat
   * floats over it. */
  const townWorld = base === "events" && eventsScreen === "world";
  /** The world fills the window: as it is, or under a visitor's panel in the
   * small window (the chat hidden). Kept apart from townWorld so opening a
   * visitor doesn't resize the world — a paused canvas that resizes goes
   * blank, and it shows through the panel's glass. */
  const townLayout =
    base === "events" &&
    (eventsScreen === "world" || eventsScreen === "visitor");
  // The Town's bigger window (its button, or Z): only while the world is on
  // screen — a visitor's screen or another tab gets the small window back,
  // and coming back to the world grows it again.
  const townExpanded = useTownExpanded();
  // Home has its own say (homeBig): it's big if it came from the big
  // Town, or was made big there.
  const bigWindow = (townWorld && townExpanded) || homeBig;
  bigWindowRef.current = bigWindow;
  /** The window button (or Z): the Town's choice in the Town (remembered),
   * Home's own at Home. */
  const toggleWindow = useCallback(() => {
    if (base === "home") setHomeBig((b) => !b);
    else toggleTownExpanded();
  }, [base]);
  const canToggleWindow =
    canExpandTown && (townWorld || (base === "home" && homeInWorld));
  useEffect(() => {
    herzies.setTownExpanded(bigWindow).catch(() => {});
  }, [bigWindow]);
  // The boss's end screen is up over the Town: the chat steps aside.
  const endScreen = endScreenUp && townWorld;

  /** Where the chat is shown (see chatPanel). */
  const chatOnScreen = base === "home" || townWorld;
  /** ...and not under a window: its keys (Enter, c) are the window's. */
  const chatReachable = chatOnScreen && !overlay;

  const requestOpenChat = useCallback(() => {
    // The Town carries its own chat, so open that one where it is (closing
    // any window over it).
    if (townWorld) {
      if (!overlay || switchView(overlay, true)) setOpenChatRequested(true);
    } else if (switchView("home")) {
      setOpenChatRequested(true);
    } else {
      openChatAfterLeaveRef.current = true;
    }
  }, [switchView, townWorld, overlay]);

  /** Escape, a click outside, ...: close the open window, the way
   * re-selecting its tab does (a live trade asks first). */
  const closeWindow = useCallback(() => {
    if (overlay) switchView(overlay, true);
  }, [overlay, switchView]);

  // Keyboard shortcuts (advertised in the nav and menu). Skipped
  // while typing in an input so chat/search fields don't switch views.
  useEffect(() => {
    if (!state.isOnline || !herzie || previewOnboarding) return;

    const shortcuts: Record<string, View> = {
      h: "home",
      o: "profile",
      i: "deck",
      b: "bag",
      j: "stats",
      k: "skills",
      t: "events",
      f: "friends",
      l: "leaderboard",
      p: "store",
    };

    const handler = (event: KeyboardEvent) => {
      // Settings: macOS's conventional Cmd+, (Ctrl+, on Windows/Linux) —
      // works from any view/focus.
      if (
        (event.metaKey || event.ctrlKey) &&
        !(event.metaKey && event.ctrlKey) &&
        !event.altKey &&
        event.key === ","
      ) {
        event.preventDefault();
        switchView("settings", true);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return;
      // Enter opens the chat where it's on screen (Home, the Town), like
      // a game's chat key — but not off a focused button or link, which
      // Enter presses.
      if (
        event.key === "Enter" &&
        chatReachable &&
        target?.tagName !== "BUTTON" &&
        target?.tagName !== "A" &&
        target?.tagName !== "SELECT"
      ) {
        event.preventDefault();
        setOpenChatRequested(true);
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z" && canToggleWindow) {
        toggleWindow();
        return;
      }
      if (key === "c") {
        // Without this the same keydown types a "c" into the freshly focused
        // chat input.
        event.preventDefault();
        requestOpenChat();
        return;
      }
      if (key === "m") {
        setMenuOpen((open) => !open);
        return;
      }
      const v = shortcuts[key];
      if (!v) return;
      if (v === "home" && homeBlocked) return;
      // Stats once the server knows stat points, Skills once there's a class.
      if (v === "stats" && !herzie.statPoints) return;
      if (v === "skills" && !herzie.class) return;
      switchView(v, true);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    state.isOnline,
    herzie,
    previewOnboarding,
    switchView,
    requestOpenChat,
    chatReachable,
    homeBlocked,
    canToggleWindow,
    toggleWindow,
  ]);

  // The Profile window: show the cached profile at once, then the fresh one.
  const selfCode = herzie?.friendCode;
  const cachedSelf = selfCode ? state.friends[selfCode] : undefined;
  const profileOpen = overlay === "profile";
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetched each time the window opens, not on every friends push
  useEffect(() => {
    if (!profileOpen || !selfCode) return;
    if (cachedSelf) setSelfProfile(cachedSelf);
    let live = true;
    herzies
      .friendLookup([selfCode])
      .then((result) => {
        if (live && result[selfCode]) setSelfProfile(result[selfCode]);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [profileOpen, selfCode]);

  // Where Home's stage sits (see useStageAlignment).
  const herzieStageTop = useHomeStageOffset();
  // The deck or the bag over Home: the herzie steps back and up, above it.
  // (In the big window the windows hang in their own column, clear of it.)
  const inventoryOnHome = base === "home" && !homeBig && isInventory(overlay);
  const windowHeight = useWindowHeight();
  /** The stage's top as drawn: raised over the deck or the bag. */
  const homeStageTop =
    herzieStageTop === null
      ? null
      : inventoryOnHome
        ? Math.min(
            herzieStageTop,
            Math.round(windowHeight / 2) - 12 - HERZIE_STAGE_HEIGHT,
          )
        : herzieStageTop;
  // Home's framing, for the world's camera when Home's shown in it: the
  // feet where the stand-in's stand (the view starts 12px down, under the
  // app's padding), as big, as far back.
  // In the big window Home's cards hang top left, as the Town's do there:
  // the herzie stands in the middle of the window, as big for the window
  // as it is in the small one.
  useEffect(() => {
    homeMode.setFrame(
      homeBig
        ? {
            feetY: Math.round(windowHeight * HOME_BIG_FEET),
            viewHeight: HOME_VIEW_HEIGHT,
            zoom: Math.min(
              HOME_BIG_MAX_ZOOM,
              Math.max(1, windowHeight / SMALL_WINDOW_HEIGHT),
            ),
            big: true,
          }
        : homeStageTop === null
          ? null
          : {
              feetY:
                12 + homeStageTop + HERZIE_STAGE_HEIGHT - STAGE_FLOOR_INSET,
              viewHeight: HOME_VIEW_HEIGHT,
              zoom: inventoryOnHome ? HOME_INVENTORY_ZOOM : 1,
            },
    );
  }, [homeStageTop, inventoryOnHome, homeBig, windowHeight]);

  if (!hydrated) {
    return <LoadingSplash />;
  }

  if (state.loggingIn) {
    return <LoadingSplash label="loading your herzie" />;
  }

  if (previewLoading) {
    return <LoadingSplash label="loading your herzie" hint="esc to close" />;
  }

  if (!state.isOnline) {
    return <SplashScreen />;
  }

  if (!herzie) {
    return <OnboardingScreen />;
  }

  if (previewOnboarding) {
    return <OnboardingScreen onClose={() => setPreviewOnboarding(false)} />;
  }

  const handleConfirmLeaveTrade = () => {
    const v = pendingLeaveView;
    const openChat = openChatAfterLeaveRef.current;
    openChatAfterLeaveRef.current = false;
    setPendingLeaveView(null);
    if (!v) return;
    // Remount TradeView so it stops polling; the trade stays alive server-side
    // and is rejoinable from the Trades tab.
    setTradeTarget(null);
    setIncomingTradeId(null);
    setTradeViewGeneration((g) => g + 1);
    setTradeActive(false);
    if (v !== "bag") setDeepLinkItem(null);
    setView(v);
    if (openChat && v === "home") setOpenChatRequested(true);
  };

  const handleStayInTrade = () => {
    openChatAfterLeaveRef.current = false;
    setPendingLeaveView(null);
  };

  const handleSpawnDebugDrop = (diceOnly = false) => {
    herzies.spawnDebugDrop(diceOnly).catch(() => {});
  };

  const handleStartTrade = (code: string) => {
    rememberTradeReturnView();
    setTradeTarget(code);
    setTradeViewGeneration((g) => g + 1);
    switchView("trade");
  };

  /** Re-enter an ongoing trade from the Social → Trades tab. */
  const handleResumeTrade = (tradeId: string) => {
    rememberTradeReturnView();
    setIncomingTradeId(tradeId);
    setTradeTarget(null);
    setTradeViewGeneration((g) => g + 1);
    switchView("trade");
  };

  const pendingIncoming = state.pendingTradeRequest ?? null;
  const showIncomingTradeOverlay =
    pendingIncoming &&
    pendingIncoming.tradeId !== ignoredIncomingTradeId &&
    !(
      overlay === "trade" &&
      incomingTradeId != null &&
      incomingTradeId === pendingIncoming.tradeId
    );

  const handleJoinIncomingTrade = () => {
    if (!pendingIncoming) return;
    rememberTradeReturnView();
    setIncomingTradeId(pendingIncoming.tradeId);
    setTradeTarget(null);
    setTradeViewGeneration((g) => g + 1);
    switchView("trade");
  };

  const handleIgnoreIncomingTrade = async () => {
    if (!pendingIncoming || incomingTradeDeclineBusy) return;
    setIncomingTradeDeclineBusy(true);
    try {
      const ok = await herzies.tradeCancel(pendingIncoming.tradeId);
      if (ok) {
        setIgnoredIncomingTradeId(pendingIncoming.tradeId);
        addLog(`Declined trade from ${pendingIncoming.fromName}`);
      } else {
        addLog("Couldn't decline trade — try again");
      }
    } finally {
      setIncomingTradeDeclineBusy(false);
    }
  };

  const pendingFriend = state.pendingFriendRequest ?? null;
  const showIncomingFriendOverlay =
    pendingFriend &&
    pendingFriend.requestId !== ignoredFriendRequestId &&
    !(overlay === "friends" && friendsTab === "requests");

  const handleAcceptFriendRequest = async () => {
    if (!pendingFriend || friendOverlayBusy) return;
    setFriendOverlayBusy("accept");
    try {
      const result = await herzies.friendRequestAccept(pendingFriend.requestId);
      // Success is logged by the backend ("Added friend …"), with their name.
      if (result.success) setIgnoredFriendRequestId(pendingFriend.requestId);
      else addLog(result.message);
    } finally {
      setFriendOverlayBusy(null);
    }
  };

  const handleDeclineFriendRequest = async () => {
    if (!pendingFriend || friendOverlayBusy) return;
    setFriendOverlayBusy("decline");
    try {
      const result = await herzies.friendRequestDecline(
        pendingFriend.requestId,
      );
      if (result.success) {
        setIgnoredFriendRequestId(pendingFriend.requestId);
        addLog(`Declined friend request from ${pendingFriend.fromName}`);
      } else {
        addLog(result.message);
      }
    } finally {
      setFriendOverlayBusy(null);
    }
  };

  const handleDismissFriendRequest = () => {
    if (!pendingFriend || friendOverlayBusy) return;
    setIgnoredFriendRequestId(pendingFriend.requestId);
  };

  // The chat docks under Home, and floats over the Town's world.
  const chatPanel =
    herzie && chatOnScreen ? (
      <ChatPanel
        activityLog={activityLog}
        isOnline={state.isOnline}
        messages={state.chatMessages}
        inventory={state.inventory}
        friends={state.friends}
        herzie={herzie}
        nowPlaying={state.nowPlaying}
        pendingFriendCodes={[
          ...state.incomingFriendRequests.map((r) => r.friendCode),
          ...state.outgoingFriendRequests.map((r) => r.friendCode),
        ]}
        openRequested={openChatRequested}
        onOpenHandled={() => setOpenChatRequested(false)}
        onOpenProfile={(code) => {
          setChatProfileCode(code);
          switchView("friends");
        }}
        onStartTrade={handleStartTrade}
        onActivity={addLog}
        frosted={townWorld}
      />
    ) : null;

  return (
    <div
      data-tauri-drag-region
      ref={hostHerzies}
      className={cn(
        "relative flex h-screen flex-col p-3",
        ghostMode && "grayscale",
      )}
    >
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden",
          // The Town's 3D world fills the whole window, out past the app's
          // padding; the chat floats over it (the dock).
          townLayout && "-m-3",
          // Home supplies its own bottom breathing room (HomeView's now-playing
          // bar) so its artist-image background can reach the chat's top
          // border instead of stopping short of an outer margin.
          base !== "home" && !townLayout && "mb-2",
        )}
      >
        {/* Home's sky (an equipped scenery item's), under the world: it
            shows as the world fades away round the herzie at Home. */}
        {homeSkyShown && herzie ? (
          <HomeSky
            userId={herzie.friendCode}
            isPlaying={!!state.nowPlaying}
            equipped={state.equipped}
            paused={base !== "home"}
          />
        ) : null}
        <div
          className={cn(
            "min-h-0 flex-1 flex-col",
            // Under Home too: Home is the world, seen from in front of your
            // herzie (town/homeMode), filling the window behind Home's own
            // cards.
            base === "events" ? "flex" : "fixed inset-0 z-0 flex",
          )}
        >
          <EventsView
            eventsTabVisible={base === "events"}
            homeShown={base === "home"}
            windowOpen={!!overlay}
            // The big window's panel only in the Town: over Home, a
            // visitor fills the small window.
            expanded={(townExpanded && base === "events") || homeBig}
            onSelectedChange={setEventsPanel}
            panelHost={panelHost}
            chatOverlay
            chatMessages={state.chatMessages}
            rootKey={rootKeys.events ?? 0}
            openRequest={townOpen}
            debugForceActive={hasActiveEventOverride}
            debugForceBoss={debugBossOverride}
            debugForceMerchant={debugMerchantOverride}
            debugForceTreatTrader={debugTreatTraderOverride}
            onScreenChange={setEventsScreen}
            equipped={
              classOverride
                ? withClassGear(state.equipped, classOverride)
                : state.equipped
            }
            units={state.units}
            currency={state.inventoryCurrency}
            onLog={addLog}
            playerSeed={herzie?.friendCode}
            playerStage={stageOverride ?? herzie?.stage}
            playerStatPoints={herzie?.statPoints}
            playerProfile={
              herzie
                ? {
                    friendCode: herzie.friendCode,
                    name: herzie.name,
                    level: herzie.level,
                    progress: levelProgress(herzie),
                    xp: herzie.xp,
                    multipliers: state.multipliers,
                    classLabel: classLabelOf(classOverride ?? herzie.class),
                    nowPlaying: state.nowPlaying,
                  }
                : undefined
            }
            musicPlaying={!!state.nowPlaying}
            onOpenProfile={(code) => {
              // Back from this profile returns to the Town.
              setChatProfileCode(code);
              if (switchView("friends")) setProfileReturn("events");
            }}
          />
        </div>
        {/* Home's herzie, over Home's stage (see useStageAlignment). Hidden,
            never unmounted, elsewhere, so coming back keeps its rotation and
            animation. A zero-height row, so it positions against the view's
            top edge without being a containing block for anything else. */}
        <div
          className={cn(
            "relative h-0 shrink-0 transition-opacity ease-out",
            // Kept under a window: Home's windows sit low on clearer glass,
            // so the herzie stays in view.
            (base !== "home" || herzieStageTop === null || !standInShown) &&
              "hidden",
            // The world's herzie has taken over: this one fades out from
            // under it, standing in the same spot.
            homeInWorld && "pointer-events-none opacity-0",
          )}
          style={{ transitionDuration: `${HOME_STAND_IN_FADE_MS}ms` }}
        >
          {/* data-window-safe: grabbing the herzie to spin it leaves the
              deck or the bag open. */}
          <div
            data-window-safe
            className="absolute inset-x-0 flex items-center justify-center transition-[top] ease-out"
            style={{
              // With the deck or the bag open (the bottom half), raised so
              // its floor meets the window's top (the view starts 12px
              // down, under the app's padding), never lowered. Moved by
              // `top`, not a transform: that would trap the sky's
              // position: fixed. In plain px, so the change animates.
              top: homeStageTop ?? 0,
              height: HERZIE_STAGE_HEIGHT,
              transitionDuration: `${HOME_INVENTORY_RAISE_MS}ms`,
            }}
          >
            <HerzieWithSky
              userId={herzie.friendCode}
              stage={stageOverride ?? herzie.stage}
              isPlaying={!!state.nowPlaying}
              equipped={
                classOverride
                  ? withClassGear(state.equipped, classOverride)
                  : state.equipped
              }
              paused={base !== "home" || homeInWorld}
              // Once Home's in the world, its sky is HomeSky's.
              showSky={!homeInWorld}
              grounded
              zoom={inventoryOnHome ? HOME_INVENTORY_ZOOM : 1}
              zoomEase={HOME_INVENTORY_ZOOM_EASE}
            />
          </div>
        </div>
        <div
          className={cn(
            // Over the world, which lies under it at Home (positioned, after
            // it: no z-index, so the player card's own z-50 still lifts it
            // over the herzie canvas).
            "relative min-h-0 flex-1 flex-col",
            base === "home" ? "flex" : "hidden",
            homeInWorld && "pointer-events-none",
          )}
        >
          <HomeView
            state={state}
            active={base === "home"}
            inWorld={homeInWorld}
            big={homeBig}
            onOpenProfile={() => switchView("profile")}
            onActivity={addLog}
          />
        </div>
      </div>

      {/* The dock: the chat, at the bottom. Over the Town it floats on the
          world; elsewhere it sits under the view. A zero-height row over the
          Town: the world keeps its full height underneath. In the big window
          it keeps the small window's width, bottom left. */}
      <div className={cn("relative -mx-3", townLayout && "h-0")}>
        <div
          ref={observeDock}
          className={cn(
            // Room under the chat for the nav's row (20px, 6px apart; the
            // nav itself is fixed, below), then 12px as at the sides: over
            // the Town, flush with the window's bottom (-mb-3 undoes the
            // app's pb-3) and its own 12px; elsewhere the app's pb-3.
            "px-3",
            townLayout
              ? "absolute inset-x-0 bottom-0 z-40 -mb-3 pb-[38px]"
              : // Its own layer, over the screens but under the overlay
                // windows (z-60): the expanded chat stays inside it.
                "relative z-55 pb-[26px]",
          )}
        >
          <div className={cn(bigWindow && "w-[356px]")}>
            {/* The boss's end screen covers the Town: the chat folds away
                under it (fading, and its space closing), and back after. */}
            <div
              className={cn(
                "grid grid-rows-[1fr] transition-[grid-template-rows,opacity] duration-300",
                endScreen && "pointer-events-none grid-rows-[0fr] opacity-0",
              )}
            >
              <div className={cn("min-h-0", endScreen && "overflow-hidden")}>
                {chatPanel}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* A drag strip along the window's top edge, over everything (the
          Town's canvas included, which otherwise takes every mouse-down), with
          a small grab handle in the middle to say it's there. The handle
          ignores the mouse, so the press lands on the strip, which carries
          the drag attribute (Tauri only drags from the element that has it). */}
      <div
        data-tauri-drag-region
        data-window-safe
        className="group fixed inset-x-0 top-0 z-80 flex h-2 cursor-grab justify-center active:cursor-grabbing"
      >
        <div className="pointer-events-none mt-[3px] h-[3px] w-9 rounded-full bg-white/20 transition-colors group-hover:bg-white/45" />
      </div>

      {/* The visitor panel's host (EventsView): fixed, it covers Home or the
          Town, under the nav and the windows. */}
      <div ref={setPanelHost} className="contents" />

      {/* The nav, under the chat: Home/World, Events, Menu. Fixed on its own
          row at the window's bottom (the dock and the windows keep clear of
          it), over the windows, so it's always in reach. Folds away with the
          chat under the boss's end screen. data-window-safe: a press here
          isn't "outside" an open window (the nav switches or closes windows
          itself). */}
      {herzie && (
        <div
          className={cn(
            "pointer-events-none fixed bottom-3 z-65 flex transition-opacity duration-300",
            bigWindow ? "left-3 w-[356px]" : "inset-x-3",
            endScreen && "opacity-0",
          )}
        >
          <div
            data-window-safe
            // The chat's width; only the buttons take the mouse, so the gap
            // between them leaves the Town clickable.
            className={cn(
              "w-full",
              !endScreen && "[&_button]:pointer-events-auto",
            )}
          >
            <TabBar
              view={view}
              base={base}
              homeBlocked={homeBlocked}
              setView={(v) => switchView(v, true)}
              menuOpen={menuOpen}
              setMenuOpen={setMenuOpen}
              hasStats={!!herzie.statPoints}
              hasSkills={!!herzie.class}
              landing={menuLanding}
              windowSize={
                canToggleWindow
                  ? { expanded: bigWindow, onToggle: toggleWindow }
                  : null
              }
              // Only once the server knows stat points: before that,
              // every herzie would show its whole back pay unspendable.
              unspentPoints={
                herzie.statPoints
                  ? statPoints(herzie.level, herzie.statPoints).unspent
                  : 0
              }
              // The bulletin board's panel, over Home or the Town alike
              // (closing any window over them); again, and it closes.
              eventsOpen={eventsPanel === BULLETIN_KEY}
              onEvents={() => {
                if (eventsPanel === BULLETIN_KEY) requestScreen(null);
                else if (!overlay || switchView(overlay, true)) {
                  requestScreen(BULLETIN_KEY);
                }
              }}
              eventsRunning={
                eventsRunning +
                Number(hasActiveEventOverride) +
                Number(debugBossOverride) +
                Number(debugMerchantOverride) +
                Number(debugTreatTraderOverride)
              }
            />
          </div>
        </div>
      )}

      {/* The windows over Home or the Town (OverlayWindow). Mounted all
          along, like the screens, so each keeps its state between visits. */}
      {herzie && (
        <OverlayWindow
          open={overlay === "profile"}
          onClosed={windowClosed("profile")}
          onClose={closeWindow}
          // The player's own profile is part of Social.
          title="Social"
          narrow={bigWindow}
          onHome={base === "home"}
          inTown={townWorld}
        >
          {selfProfile ? (
            <ProfileView
              profile={
                // The synced profile's nowPlaying.albumArtUrl only ever holds
                // Last.fm's art (see sync_tick in lib.rs — the local system
                // artwork data: URL is never synced). Prefer the live local
                // value here, which does include it, whenever it's still the
                // same track — avoids a stale mismatch right after a track
                // change, before the next sync tick catches up.
                selfProfile.nowPlaying &&
                state.nowPlaying &&
                state.nowPlaying.title === selfProfile.nowPlaying.title &&
                state.nowPlaying.artist === selfProfile.nowPlaying.artist &&
                state.nowPlaying.albumArtUrl
                  ? {
                      ...selfProfile,
                      nowPlaying: {
                        ...selfProfile.nowPlaying,
                        albumArtUrl: state.nowPlaying.albumArtUrl,
                      },
                    }
                  : selfProfile
              }
              isSelf
              isFriend
              stageOverride={stageOverride}
              active={windowShown("profile")}
              onTrade={() => {}}
              onAdd={() => {}}
              onRemove={() => {}}
            />
          ) : (
            <div className="pt-5 text-center text-ui text-text-dim">
              Loading...
            </div>
          )}
        </OverlayWindow>
      )}

      {/* The deck and the bag: one window, a tab each (the menu has an item
          for each too). InventoryView portals into it. */}
      {herzie && (
        <>
          <OverlayWindow
            open={isInventory(overlay)}
            onClosed={() =>
              setLeavingOverlay((l) => (isInventory(l) ? null : l))
            }
            onClose={closeWindow}
            title="Herzie"
            narrow={bigWindow}
            onHome={base === "home"}
            inTown={townWorld}
            half
            fit
          >
            <div
              ref={setInventorySlot}
              className="flex min-h-0 flex-1 flex-col"
            />
          </OverlayWindow>
          <InventoryView
            herzie={herzie}
            initialItem={deepLinkItem}
            // An inventory with items but no copies is a cache from before
            // copies existed: laying out an empty bank from it would show the
            // player nothing until the first sync (and indefinitely offline),
            // so it counts as not loaded yet.
            loaded={
              state.inventory != null &&
              (state.units.length > 0 ||
                Object.keys(state.inventory).length === 0)
            }
            units={state.units}
            currency={state.inventoryCurrency}
            equipped={state.equipped}
            onToggleEquip={toggleEquip}
            onPredictUnits={predict}
            bankExpansions={state.bankExpansions}
            onLog={addLog}
            slot={inventorySlot}
            open={isInventory(overlay)}
            panel={inventoryPanel}
            onPanelChange={(p) => switchView(p as HerzieTab)}
            onTabLanded={onTabLanded}
            extraTabs={[
              ...(herzie.statPoints
                ? [
                    {
                      id: "stats",
                      label: "Stats",
                      content: (
                        <StatsTab
                          // Read off the copies, so each worn one counts at
                          // its own upgrade level.
                          stats={getHerzieStatsFromUnits(state.units)}
                          level={herzie.level}
                          points={herzie.statPoints}
                          onLog={addLog}
                        />
                      ),
                    },
                  ]
                : []),
              ...(herzie.class
                ? [
                    {
                      id: "skills",
                      label: "Skills",
                      content: (
                        <SkillsPanel
                          herzieClass={herzie.class}
                          skills={state.skills}
                        />
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </>
      )}

      {herzie && (
        <OverlayWindow
          open={overlay === "friends"}
          onClosed={windowClosed("friends")}
          onClose={closeWindow}
          title="Social"
          narrow={bigWindow}
          onHome={base === "home"}
          inTown={townWorld}
        >
          <FriendsView
            herzie={herzie}
            friends={state.friends}
            incomingRequests={state.incomingFriendRequests}
            outgoingRequests={state.outgoingFriendRequests}
            onStartTrade={handleStartTrade}
            onResumeTrade={handleResumeTrade}
            stageOverride={stageOverride}
            openProfileCode={chatProfileCode}
            onProfileOpened={() => setChatProfileCode(null)}
            onProfileBack={() => {
              if (profileReturn) switchView(profileReturn);
            }}
            openedFromTown={profileReturn === "events"}
            tab={friendsTab}
            onTabChange={setFriendsTab}
            onActivity={addLog}
            active={windowShown("friends")}
            rootKey={rootKeys.friends ?? 0}
          />
        </OverlayWindow>
      )}

      {herzie && (
        <OverlayWindow
          open={overlay === "leaderboard"}
          onClosed={windowClosed("leaderboard")}
          onClose={closeWindow}
          title="Leaderboard"
          narrow={bigWindow}
          onHome={base === "home"}
          inTown={townWorld}
        >
          <LeaderboardView
            herzieName={herzie.name}
            active={windowShown("leaderboard")}
          />
        </OverlayWindow>
      )}

      {herzie && (
        <OverlayWindow
          open={overlay === "trade"}
          onClosed={windowClosed("trade")}
          onClose={closeWindow}
          title="Trade"
          titleClassName="text-purple"
          narrow={bigWindow}
          onHome={base === "home"}
          inTown={townWorld}
        >
          <TradeView
            key={tradeViewGeneration}
            herzie={herzie}
            initialTarget={tradeTarget}
            initialTradeId={incomingTradeId}
            units={state.units}
            currency={state.inventoryCurrency}
            onActiveChange={setTradeActive}
            onClose={() => {
              setTradeTarget(null);
              setIncomingTradeId(null);
              setTradeViewGeneration((g) => g + 1);
              setTradeActive(false);
              // Back to the window the trade started from (Social, say), or
              // to the screen underneath.
              setOverlay(tradeReturnViewRef.current);
            }}
          />
        </OverlayWindow>
      )}

      <OverlayWindow
        open={overlay === "store"}
        onClosed={windowClosed("store")}
        onClose={closeWindow}
        title="Premium"
        titleClassName="text-yellow"
        narrow={bigWindow}
        onHome={base === "home"}
        inTown={townWorld}
      >
        <StoreView
          inventory={state.inventory}
          currency={state.inventoryCurrency}
          equipped={state.equipped}
          bankExpansions={state.bankExpansions}
          active={windowShown("store")}
        />
      </OverlayWindow>

      <OverlayWindow
        open={overlay === "settings"}
        onClosed={windowClosed("settings")}
        onClose={closeWindow}
        title="Settings"
        narrow={bigWindow}
        onHome={base === "home"}
        inTown={townWorld}
      >
        <SettingsView
          state={state}
          stageOverride={stageOverride}
          onStageOverride={setStageOverride}
          classOverride={classOverride}
          onClassOverride={setClassOverride}
          onTestClassChoice={() => setTestClassChoice(true)}
          onPreviewOnboarding={() => setPreviewOnboarding(true)}
          onPreviewLoading={() => setPreviewLoading(true)}
          onTestUpdateAlert={() => setTestUpdateOverlay(true)}
          onTestWhatsNew={() => setTestWhatsNewOverlay(true)}
          hasActiveEventOverride={hasActiveEventOverride}
          onToggleActiveEventOverride={() =>
            setHasActiveEventOverride((v) => !v)
          }
          debugBossOverride={debugBossOverride}
          onToggleDebugBoss={() => setDebugBossOverride((v) => !v)}
          debugMerchantOverride={debugMerchantOverride}
          onToggleDebugMerchant={() => setDebugMerchantOverride((v) => !v)}
          debugTreatTraderOverride={debugTreatTraderOverride}
          onToggleDebugTreatTrader={() =>
            setDebugTreatTraderOverride((v) => !v)
          }
          onSpawnDebugDrop={handleSpawnDebugDrop}
          availableUpdate={availableUpdate}
          installStatus={updateInstallStatus}
          onInstallUpdate={handleInstallUpdate}
        />
      </OverlayWindow>

      {pendingLeaveView && (
        <PromptOverlay
          title="Leave trade?"
          titleId="leave-trade-title"
          onEscape={handleStayInTrade}
          actions={[
            {
              label: "Stay",
              colour: "text-text-dim",
              onClick: handleStayInTrade,
            },
            {
              label: "Leave",
              colour: "text-purple",
              onClick: handleConfirmLeaveTrade,
            },
          ]}
        >
          Are you sure you want to leave? The trade stays open — you can rejoin
          it from Social → Trades.
        </PromptOverlay>
      )}

      {herzie && inventoryFull && !dismissedInventoryFull && (
        <PromptOverlay
          title="Inventory full"
          titleId="inventory-full-title"
          onEscape={() => setDismissedInventoryFull(true)}
          actions={[
            {
              label: "Later",
              colour: "text-text-dim",
              onClick: () => setDismissedInventoryFull(true),
            },
            {
              label: "Open bag",
              colour: "text-purple",
              onClick: () => {
                setDismissedInventoryFull(true);
                switchView("bag");
              },
            },
          ]}
        >
          Your inventory is full. Sell something from your bag to free up a slot
          before you pick up or buy anything else.
        </PromptOverlay>
      )}

      {herzie && showIncomingTradeOverlay && pendingIncoming && (
        <IncomingTradeOverlay
          request={pendingIncoming}
          busy={incomingTradeDeclineBusy ? "ignore" : null}
          onJoin={handleJoinIncomingTrade}
          onIgnore={handleIgnoreIncomingTrade}
        />
      )}

      {herzie && showIncomingFriendOverlay && pendingFriend && (
        <IncomingFriendOverlay
          request={pendingFriend}
          busy={friendOverlayBusy}
          onAccept={handleAcceptFriendRequest}
          onDecline={handleDeclineFriendRequest}
          onDismiss={handleDismissFriendRequest}
        />
      )}

      {herzie &&
        availableUpdate &&
        availableUpdate.version !== dismissedUpdateVersion &&
        overlay !== "settings" && (
          <UpdateAvailableOverlay
            version={availableUpdate.version}
            onUpdate={handleInstallUpdate}
            onLater={() => setDismissedUpdateVersion(availableUpdate.version)}
            installing={updateInstallStatus.kind === "installing"}
            progress={
              updateInstallStatus.kind === "installing"
                ? {
                    downloaded: updateInstallStatus.downloaded,
                    total: updateInstallStatus.total,
                  }
                : undefined
            }
            error={
              updateInstallStatus.kind === "error"
                ? updateInstallStatus.message
                : undefined
            }
          />
        )}

      {testUpdateOverlay && (
        <UpdateAvailableOverlay
          version="9.9.9-test"
          onUpdate={() => setTestUpdateOverlay(false)}
          onLater={() => setTestUpdateOverlay(false)}
          installing={false}
        />
      )}

      {herzie &&
        ((needsClassChoice(herzie) && !classChoiceLater) ||
          testClassChoice) && (
          <ClassChoiceOverlay
            onChoose={async (c) => {
              await herzies.chooseClass(c);
              setTestClassChoice(false);
            }}
            onLater={() => {
              setClassChoiceLater(true);
              setTestClassChoice(false);
            }}
          />
        )}

      {herzie && whatsNewVersion && (
        <WhatsNewOverlay
          version={whatsNewVersion}
          highlights={
            RELEASE_NOTES.find((entry) => entry.version === whatsNewVersion)
              ?.highlights ?? []
          }
          onClose={() => {
            localStorage.setItem(WHATS_NEW_SEEN_KEY, whatsNewVersion);
            setWhatsNewVersion(null);
          }}
        />
      )}

      {testWhatsNewOverlay && (
        <WhatsNewOverlay
          version="9.9.9-test"
          highlights={[
            "Added a curated 'What's new' modal",
            "Fixed a sample bug for the debug preview",
          ]}
          onClose={() => setTestWhatsNewOverlay(false)}
        />
      )}

      {/* Transparent tint over the whole app; pointer-events-none so the ghost
          toggle and everything else stay interactive. The "music is not
          tracked" copy lives in the now-playing card in HomeView. */}
      {ghostMode && (
        <div className="pointer-events-none fixed inset-0 z-200 bg-black/30" />
      )}

      {/* Short messages that matter now (lib/notices.ts). */}
      <Notices />
    </div>
  );
}

// Pipes the Rust side's `log` output into this webview's console, so backend
// and frontend lines interleave in devtools instead of only reaching the
// terminal running `tauri dev`. The plugin's Webview target emits events; this
// is the subscriber that turns them into console output, and without it that
// target goes nowhere.
attachConsole().catch(() => {
  // Logging is a debugging aid, never a reason to fail startup.
});

const root = createRoot(document?.getElementById("root") ?? document.body);
root.render(<App />);
