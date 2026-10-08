import "./globals.css";
import { bankCapacity, type HerzieProfile, isBankFull } from "@herzies/shared";
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
import { EventsView } from "./components/EventsView";
import { FriendsView } from "./components/FriendsView";
import { HERZIE_STAGE_HEIGHT, Herzie3D } from "./components/Herzie3D";
import { HomeView } from "./components/HomeView";
import { IncomingFriendOverlay } from "./components/IncomingFriendOverlay";
import { IncomingTradeOverlay } from "./components/IncomingTradeOverlay";
import { HERZIE_ZONE_ATTR, InventoryView } from "./components/InventoryView";
import { LoadingSplash } from "./components/LoadingSplash";
import { OnboardingScreen } from "./components/OnboardingScreen";
import { ProfileView } from "./components/ProfileView";
import { PromptOverlay } from "./components/PromptOverlay";
import { SettingsView } from "./components/SettingsView";
import { SplashScreen } from "./components/SplashScreen";
import { StoreView } from "./components/StoreView";
import { TabBar, type View } from "./components/TabBar";
import { TradeView } from "./components/TradeView";
import { UpdateAvailableOverlay } from "./components/UpdateAvailableOverlay";
import { WhatsNewOverlay } from "./components/WhatsNewOverlay";
import { useOptimisticUnits } from "./hooks/useOptimisticUnits";
import { useHomeStageOffset } from "./hooks/useStageAlignment";
import { useTradeRequests } from "./hooks/useTradeRequests";
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
/** Render-grid density of the herzie on Home and the Herzie view: a third
 * finer than the classic grid, drawn as solid blocks. */
const HERZIE_RESOLUTION = 4 / 3;
/** The camera on the Herzie view, relative to Home's: pulled back and raised
 * a little to make room for the deck over the stage's floor. */
const HERZIE_VIEW_ZOOM = 0.83;
/** px; negative is up. */
const HERZIE_VIEW_OFFSET_Y = -14;

type UpdateInstallStatus =
  | { kind: "idle" }
  | { kind: "installing"; downloaded: number; total: number | undefined }
  | { kind: "error"; message: string };

function App() {
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
  const [view, setView] = useState<View>("home");
  // Bumped when the player re-selects the tab they're already on (click or
  // shortcut), so a view that's drilled into a sub-screen — Town → George,
  // Social → a profile — goes back to its top level.
  const [rootKeys, setRootKeys] = useState<Partial<Record<View, number>>>({});
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
  const [bossHatedGenres, setBossHatedGenres] = useState<string[]>([]);
  const [chatProfileCode, setChatProfileCode] = useState<string | null>(null);
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
  const tradeReturnViewRef = useRef<View>("home");
  /** Current view, readable from effect closures (deep-link handler). */
  const viewRef = useRef(view);
  viewRef.current = view;

  /** Snapshot the current view so closing the trade can return to it. */
  const rememberTradeReturnView = useCallback(() => {
    if (viewRef.current !== "trade") {
      tradeReturnViewRef.current = viewRef.current;
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
    const unlistenActivity = herzies.onActivity(addLog);
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
        setView("inventory");
      }
    });
    return () => {
      unlistenState();
      unlistenActivity();
      unlistenDeepLink();
    };
  }, [addLog, rememberTradeReturnView]);

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
    const onEvents = view === "events";
    const root = document.documentElement.classList;
    root.toggle("boss-mode", onEvents && eventsScreen === "boss");
    root.toggle("merchant-mode", onEvents && eventsScreen === "merchant");
    return () => root.remove("boss-mode", "merchant-mode");
  }, [view, eventsScreen]);

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
        const boss = events.find((e) => e.type === "boss_fight");
        // Drives the red genre pills on the now-playing card, so the player
        // can see a track is hurting the boss without opening the Events tab.
        setBossHatedGenres(
          ((boss?.config as { hatedGenres?: string[] } | undefined)
            ?.hatedGenres ?? []) as string[],
        );
      })
      .catch(() => {
        setVisitorsInTown(0);
        setBossHatedGenres([]);
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
  }, [state.isOnline]);

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
    (v: View): boolean => {
      // Leaving an in-progress trade needs confirmation. The trade itself stays
      // open server-side and can be rejoined from Social → Trades.
      if (view === "trade" && v !== "trade" && tradeActive) {
        setPendingLeaveView(v);
        return false;
      }
      if (v !== "inventory") setDeepLinkItem(null);
      if (v !== "trade") {
        setIncomingTradeId(null);
        setTradeTarget(null);
      }
      setSelfProfile(null);
      if (v === view) {
        setRootKeys((keys) => ({ ...keys, [v]: (keys[v] ?? 0) + 1 }));
      }
      setView(v);
      return true;
    },
    [view, tradeActive],
  );

  /** "c" shortcut: go home and focus the chat. Mid-trade this routes through
   * the leave-trade confirmation like every other view switch. */
  /** The Town's 3D world is on screen: it fills the window, and the chat
   * floats over it. */
  const townWorld = view === "events" && eventsScreen === "world";

  const requestOpenChat = useCallback(() => {
    // The Town carries its own chat, so open that one where it is.
    if (townWorld) {
      setOpenChatRequested(true);
    } else if (switchView("home")) {
      setOpenChatRequested(true);
    } else {
      openChatAfterLeaveRef.current = true;
    }
  }, [switchView, townWorld]);

  // Tab keyboard shortcuts (advertised in the tab bar tooltips). Skipped
  // while typing in an input so chat/search fields don't switch views.
  useEffect(() => {
    if (!state.isOnline || !herzie || previewOnboarding) return;

    const shortcuts: Record<string, View> = {
      h: "home",
      i: "inventory",
      t: "events",
      f: "friends",
      b: "store",
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
        switchView("settings");
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
      const key = event.key.toLowerCase();
      if (key === "c") {
        // Without this the same keydown types a "c" into the freshly focused
        // chat input.
        event.preventDefault();
        requestOpenChat();
        return;
      }
      const v = shortcuts[key];
      if (v) switchView(v);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [state.isOnline, herzie, previewOnboarding, switchView, requestOpenChat]);

  // Where Home's and the Herzie view's stages sit (see useStageAlignment).
  const herzieStageTop = useHomeStageOffset();

  if (!hydrated) {
    return <LoadingSplash />;
  }

  if (state.loggingIn) {
    return <LoadingSplash label="loading your herzie" />;
  }

  if (previewLoading) {
    return <LoadingSplash label="loading your herzie (esc to close)" />;
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
    if (v !== "inventory") setDeepLinkItem(null);
    setSelfProfile(null);
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

  const handleOpenSelfProfile = async () => {
    const code = herzie?.friendCode;
    if (!code) return;
    const cached = state.friends[code];
    if (cached) setSelfProfile(cached);
    const result = await herzies.friendLookup([code]);
    if (result[code]) setSelfProfile(result[code]);
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
      view === "trade" &&
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
    !(view === "friends" && friendsTab === "requests");

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
    herzie && ((view === "home" && !selfProfile) || townWorld) ? (
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
      />
    ) : null;

  return (
    <div
      data-tauri-drag-region
      className={cn(
        "relative flex h-screen flex-col px-3 pt-3 pb-1",
        ghostMode && "grayscale",
      )}
    >
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden",
          // The Town's 3D world fills the window down to the tab bar: out
          // past the app's side and top padding.
          townWorld && "-mx-3 -mt-3",
          // Home supplies its own bottom breathing room (HomeView's now-playing
          // bar) so its artist-image background can reach the chat's top
          // border instead of stopping short of an outer margin. The viewer's
          // own profile shares the home slot but has no such bar, so it takes
          // the margin like every other view — otherwise it sits tighter to
          // the chat than the same profile opened from Social.
          (view !== "home" || !!selfProfile) &&
            view !== "inventory" &&
            !townWorld &&
            "mb-2",
        )}
      >
        {/* The herzie on Home and the Herzie view: one renderer over both
            views' stages, so switching between them keeps its rotation and
            animation and just eases the camera out a little on the Herzie
            view (room for the deck over its floor). Hidden, never unmounted,
            elsewhere. A zero-height row, so it positions against the views'
            top edge without being a containing block for anything else. */}
        <div
          className={cn(
            "relative h-0 shrink-0",
            ((view !== "home" && view !== "inventory") ||
              (view === "home" && !!selfProfile) ||
              herzieStageTop === null) &&
              "hidden",
          )}
        >
          <div
            {...(view === "inventory" ? { [HERZIE_ZONE_ATTR]: "" } : {})}
            className="absolute inset-x-0 flex items-center justify-center"
            style={{ top: herzieStageTop ?? 0, height: HERZIE_STAGE_HEIGHT }}
          >
            <Herzie3D
              userId={herzie.friendCode}
              stage={stageOverride ?? herzie.stage}
              isPlaying={!!state.nowPlaying}
              equipped={state.equipped}
              paused={
                (view !== "home" && view !== "inventory") ||
                (view === "home" && !!selfProfile)
              }
              zoom={view === "inventory" ? HERZIE_VIEW_ZOOM : 1}
              offsetY={view === "inventory" ? HERZIE_VIEW_OFFSET_Y : 0}
              grounded
              // Solid pixels on a third-finer grid, like the Town's herzies.
              solid
              resolution={HERZIE_RESOLUTION}
            />
          </div>
        </div>
        <div
          className={cn(
            "min-h-0 flex-1 flex-col",
            view === "home" ? "flex" : "hidden",
          )}
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
              active={view === "home"}
              onBack={() => setSelfProfile(null)}
              onTrade={() => {}}
              onAdd={() => {}}
              onRemove={() => {}}
            />
          ) : (
            <HomeView
              state={state}
              active={view === "home"}
              onOpenProfile={handleOpenSelfProfile}
              onOpenSettings={() => switchView("settings")}
              onActivity={addLog}
              bossHatedGenres={bossHatedGenres}
            />
          )}
        </div>

        {herzie && (
          <div
            className={cn(
              "min-h-0 flex-1 flex-col",
              view === "friends" ? "flex" : "hidden",
            )}
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
              tab={friendsTab}
              onTabChange={setFriendsTab}
              onActivity={addLog}
              active={view === "friends"}
              rootKey={rootKeys.friends ?? 0}
            />
          </div>
        )}

        {herzie && (
          <div
            className={cn(
              "min-h-0 flex-1 flex-col",
              view === "inventory" ? "flex" : "hidden",
            )}
          >
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
              active={view === "inventory"}
              rootKey={rootKeys.inventory ?? 0}
            />
          </div>
        )}

        <div
          className={cn(
            "min-h-0 flex-1 flex-col",
            view === "events" ? "flex" : "hidden",
          )}
        >
          <EventsView
            eventsTabVisible={view === "events"}
            chatOverlay
            rootKey={rootKeys.events ?? 0}
            debugForceActive={hasActiveEventOverride}
            debugForceBoss={debugBossOverride}
            debugForceMerchant={debugMerchantOverride}
            debugForceTreatTrader={debugTreatTraderOverride}
            onScreenChange={setEventsScreen}
            equipped={state.equipped}
            units={state.units}
            currency={state.inventoryCurrency}
            onLog={addLog}
            playerSeed={herzie?.friendCode}
            playerStage={stageOverride ?? herzie?.stage}
          />
        </div>

        {herzie && (
          <div
            className={cn(
              "min-h-0 flex-1 flex-col",
              view === "trade" ? "flex" : "hidden",
            )}
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
                // Return to wherever the user was before the trade started.
                setView(tradeReturnViewRef.current);
              }}
            />
          </div>
        )}

        <div
          className={cn(
            "min-h-0 flex-1 flex-col",
            view === "store" ? "flex" : "hidden",
          )}
        >
          <StoreView
            inventory={state.inventory}
            currency={state.inventoryCurrency}
            equipped={state.equipped}
            bankExpansions={state.bankExpansions}
            active={view === "store"}
          />
        </div>

        <div
          className={cn(
            "min-h-0 flex-1 flex-col",
            view === "settings" ? "flex" : "hidden",
          )}
        >
          <SettingsView
            state={state}
            stageOverride={stageOverride}
            onStageOverride={setStageOverride}
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
        </div>
      </div>

      {chatPanel &&
        (townWorld ? (
          // Over the bottom of the Town's world, edge to edge, on a
          // translucent backing so the world shows through. A zero-height
          // row: the world keeps its full height underneath.
          <div className="relative -mx-3 h-0">
            <div className="absolute inset-x-0 bottom-0 z-20 bg-black/55 px-3 backdrop-blur-[2px]">
              {chatPanel}
            </div>
          </div>
        ) : (
          chatPanel
        ))}

      {herzie && (
        <TabBar
          view={view}
          setView={switchView}
          visitorsInTown={
            visitorsInTown +
            Number(hasActiveEventOverride) +
            Number(debugBossOverride) +
            Number(debugMerchantOverride) +
            Number(debugTreatTraderOverride)
          }
        />
      )}

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
              label: "Open inventory",
              colour: "text-purple",
              onClick: () => {
                setDismissedInventoryFull(true);
                switchView("inventory");
              },
            },
          ]}
        >
          Your inventory is full. Sell something from Cards to free up a slot
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
        view !== "settings" && (
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
