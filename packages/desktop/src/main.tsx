import "./globals.css";
import {
  attackStyle,
  bankCapacity,
  CLASS_DEFS,
  getHerzieStatsFromUnits,
  type HerzieClass,
  type HerzieProfile,
  hasRoomFor,
  isBankFull,
  levelProgress,
  needsClassChoice,
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
import { HERZIE_STAGE_HEIGHT, HerzieWithSky } from "./components/HerzieWithSky";
import { HomeView } from "./components/HomeView";
import { IncomingFriendOverlay } from "./components/IncomingFriendOverlay";
import { IncomingTradeOverlay } from "./components/IncomingTradeOverlay";
import { InventoryView } from "./components/InventoryView";
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
import { setLootRoom } from "./components/town/combat/lootFeed";
import { useBossResultsShown } from "./components/town/combat/results";
import { setMySkill } from "./components/town/combat/skills";
import { combat } from "./components/town/combat/state";
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
  if (el) dockObserver.observe(el);
}

/** ...and the nav's width as `--nav-width`: Home's header keeps that much
 * room at its right, where the nav sits over it. */
const navObserver = new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty(
    "--nav-width",
    `${(entry.target as HTMLElement).offsetWidth}px`,
  );
});
function observeNav(el: HTMLDivElement | null) {
  navObserver.disconnect();
  if (el) navObserver.observe(el);
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
  // The Town is where the app opens; Home is the other screen. Herzie,
  // Social, Premium, Settings and a trade open over either as a window.
  const [base, setBase] = useState<Base>("events");
  const [overlay, setOverlay] = useState<OverlayId | null>(null);
  /** What the nav shows as selected. */
  const view: View = overlay ?? base;
  // The window that was just closed (or swapped for another) stays "shown"
  // until its exit has played: its content keeps still under the fade.
  const [leavingOverlay, setLeavingOverlay] = useState<OverlayId | null>(null);
  const [prevOverlay, setPrevOverlay] = useState<OverlayId | null>(overlay);
  /** Deck and Bag are one window's two tabs: switching between them isn't
   * leaving it. */
  const isInventory = (v: View | null) => v === "deck" || v === "bag";
  if (prevOverlay !== overlay) {
    setPrevOverlay(overlay);
    if (prevOverlay && !(isInventory(prevOverlay) && isInventory(overlay))) {
      setLeavingOverlay(prevOverlay);
    }
  }
  /** The deck-and-bag window's tab: the one asked for last. */
  const [inventoryPanel, setInventoryPanel] = useState<"deck" | "bag">("deck");
  if (isInventory(overlay) && overlay !== inventoryPanel) {
    setInventoryPanel(overlay as "deck" | "bag");
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
  // The Town's skill bar follows the class skill the app knows about — or,
  // under a Class Preview, that class's starter skill at Lv. 1 (practice on
  // the training grounds works; the cave's server refuses it).
  useEffect(
    () =>
      setMySkill(
        classOverride
          ? [
              {
                skillId: CLASS_DEFS[classOverride].starterSkill,
                level: 1,
              },
            ]
          : rawState.skills,
      ),
    [rawState.skills, classOverride],
  );
  // How the Town's basic attack goes: by class (a Record Slinger throws its
  // discs), the Class Preview's while one's on.
  useEffect(() => {
    combat.attack = attackStyle(classOverride ?? rawState.herzie?.class);
  }, [rawState.herzie?.class, classOverride]);
  // A new class or level: the Town server judges casts from the ticket (a
  // class's attack; the Tower's level gap), so it gets a fresh one. After a
  // beat, so the server has the change saved.
  const ticketKey = `${rawState.herzie?.class ?? ""}|${rawState.herzie?.level ?? 0}`;
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
  /** Visitors in Town right now (live song hunt, boss, George) — the Town
   * tab's badge. */
  const [visitorsInTown, setVisitorsInTown] = useState(0);
  const [hasActiveEventOverride, setHasActiveEventOverride] = useState(false);
  const [debugBossOverride, setDebugBossOverride] = useState(false);
  const [debugMerchantOverride, setDebugMerchantOverride] = useState(false);
  const [debugTreatTraderOverride, setDebugTreatTraderOverride] =
    useState(false);
  /** Which full-screen event view the Events tab has open, if any. */
  const [eventsScreen, setEventsScreen] = useState<
    "boss" | "merchant" | "world" | null
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
    "friends" | "requests" | "add" | "trades" | "leaderboard"
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
        setVisitorsInTown(
          events.filter(
            (e) =>
              e.type === "song_hunt" ||
              e.type === "boss_fight" ||
              e.type === "merchant",
          ).length,
        );
      })
      .catch(() => {
        setVisitorsInTown(0);
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
      setView("events");
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

  /** "c" shortcut: go home and focus the chat. Mid-trade this routes through
   * the leave-trade confirmation like every other view switch. */
  /** The Town's 3D world is on screen: it fills the window, and the chat
   * floats over it. */
  const townWorld = base === "events" && eventsScreen === "world";
  // The Town's bigger window (its button, or Z): only while the world is on
  // screen — a visitor's screen or another tab gets the small window back,
  // and coming back to the world grows it again.
  const townExpanded = useTownExpanded();
  const bigWindow = townWorld && townExpanded;
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
      if (key === "z" && townWorld) {
        toggleTownExpanded();
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
    townWorld,
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
          townWorld && "-m-3",
          // Home supplies its own bottom breathing room (HomeView's now-playing
          // bar) so its artist-image background can reach the chat's top
          // border instead of stopping short of an outer margin.
          base !== "home" && !townWorld && "mb-2",
        )}
      >
        {/* Home's herzie, over Home's stage (see useStageAlignment). Hidden,
            never unmounted, elsewhere, so coming back keeps its rotation and
            animation. A zero-height row, so it positions against the view's
            top edge without being a containing block for anything else. */}
        <div
          className={cn(
            "relative h-0 shrink-0",
            // Under a window too: blurred through its glass, it's just a blob.
            (base !== "home" ||
              !!overlay ||
              !!leavingOverlay ||
              herzieStageTop === null) &&
              "hidden",
          )}
        >
          <div
            className="absolute inset-x-0 flex items-center justify-center"
            style={{ top: herzieStageTop ?? 0, height: HERZIE_STAGE_HEIGHT }}
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
              paused={base !== "home" || !!overlay || !!leavingOverlay}
              grounded
            />
          </div>
        </div>
        <div
          className={cn(
            "min-h-0 flex-1 flex-col",
            base === "home" ? "flex" : "hidden",
          )}
        >
          <HomeView
            state={state}
            active={base === "home"}
            onOpenProfile={() => switchView("profile")}
            onActivity={addLog}
          />
        </div>

        <div
          className={cn(
            "min-h-0 flex-1 flex-col",
            base === "events" ? "flex" : "hidden",
          )}
        >
          <EventsView
            eventsTabVisible={base === "events"}
            windowOpen={!!overlay}
            chatOverlay
            chatMessages={state.chatMessages}
            rootKey={rootKeys.events ?? 0}
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
      </div>

      {/* The dock: the chat, at the bottom. Over the Town it floats on the
          world; elsewhere it sits under the view. A zero-height row over the
          Town: the world keeps its full height underneath. In the big window
          it keeps the small window's width, bottom left. */}
      <div className={cn("relative -mx-3", townWorld && "h-0")}>
        <div
          ref={observeDock}
          className={cn(
            // 12px under the chat, as at the sides: over the Town, flush
            // with the window's bottom (-mb-3 undoes the app's pb-3) and its
            // own pb-3; elsewhere the app's pb-3.
            "px-3",
            townWorld
              ? "absolute inset-x-0 bottom-0 z-40 -mb-3 pb-3"
              : // Its own layer, over the screens but under the overlay
                // windows (z-60): the expanded chat stays inside it.
                "relative z-55",
          )}
        >
          {/* The boss's end screen covers the Town: the chat folds away
              under it (fading, and its space closing), and back after. */}
          <div
            className={cn(
              "grid grid-rows-[1fr] transition-[grid-template-rows,opacity] duration-300",
              bigWindow && "w-[356px]",
              endScreen && "pointer-events-none grid-rows-[0fr] opacity-0",
            )}
          >
            <div className={cn("min-h-0", endScreen && "overflow-hidden")}>
              {chatPanel}
            </div>
          </div>
        </div>
      </div>

      {/* The nav: top right, on Home and in the Town, over the windows
          (z-60), which start under its row. In the header's 20px row (the
          app's 12px top margin), level with Home's name and the Town's. */}
      {herzie && (
        <div ref={observeNav} className="fixed top-3 right-3 z-65">
          <TabBar
            view={view}
            base={base}
            setView={(v) => switchView(v, true)}
            menuOpen={menuOpen}
            setMenuOpen={setMenuOpen}
            hasStats={!!herzie.statPoints}
            hasSkills={!!herzie.class}
            landing={menuLanding}
            windowSize={
              townWorld && canExpandTown
                ? { expanded: townExpanded, onToggle: toggleTownExpanded }
                : null
            }
            // Only once the server knows stat points: before that,
            // every herzie would show its whole back pay unspendable.
            unspentPoints={
              herzie.statPoints
                ? statPoints(herzie.level, herzie.statPoints).unspent
                : 0
            }
            visitorsInTown={
              visitorsInTown +
              Number(hasActiveEventOverride) +
              Number(debugBossOverride) +
              Number(debugMerchantOverride) +
              Number(debugTreatTraderOverride)
            }
          />
        </div>
      )}

      {/* The windows over Home or the Town (OverlayWindow). Mounted all
          along, like the screens, so each keeps its state between visits. */}
      {herzie && (
        <OverlayWindow
          open={overlay === "profile"}
          onClosed={windowClosed("profile")}
          onClose={closeWindow}
          label="Profile"
          narrow={bigWindow}
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
              onBack={closeWindow}
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
            label="Deck and bag"
            narrow={bigWindow}
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
            onPanelChange={(p) => switchView(p)}
            onTabLanded={onTabLanded}
          />
        </>
      )}

      {herzie?.statPoints && (
        <OverlayWindow
          open={overlay === "stats"}
          onClosed={windowClosed("stats")}
          onClose={closeWindow}
          label="Stats"
          narrow={bigWindow}
        >
          <h1 className="mb-2 text-ui-lg font-bold text-cyan">Stats</h1>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <StatsTab
              // Read off the copies, so each worn one counts at its own
              // upgrade level.
              stats={getHerzieStatsFromUnits(state.units)}
              level={herzie.level}
              points={herzie.statPoints}
              onLog={addLog}
            />
          </div>
        </OverlayWindow>
      )}

      {herzie?.class && (
        <OverlayWindow
          open={overlay === "skills"}
          onClosed={windowClosed("skills")}
          onClose={closeWindow}
          label="Skills"
          narrow={bigWindow}
        >
          <h1 className="mb-2 text-ui-lg font-bold text-cyan">Skills</h1>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <SkillsPanel herzieClass={herzie.class} skills={state.skills} />
          </div>
        </OverlayWindow>
      )}

      {herzie && (
        <OverlayWindow
          open={overlay === "friends"}
          onClosed={windowClosed("friends")}
          onClose={closeWindow}
          label="Social"
          narrow={bigWindow}
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
          open={overlay === "trade"}
          onClosed={windowClosed("trade")}
          onClose={closeWindow}
          label="Trade"
          narrow={bigWindow}
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
        label="Premium"
        narrow={bigWindow}
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
        label="Settings"
        narrow={bigWindow}
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
