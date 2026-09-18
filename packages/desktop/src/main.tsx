import "./globals.css";
import { type HerzieProfile, isBankFull } from "@herzies/shared";
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
import { HomeView } from "./components/HomeView";
import { IncomingFriendOverlay } from "./components/IncomingFriendOverlay";
import { IncomingTradeOverlay } from "./components/IncomingTradeOverlay";
import { InventoryView } from "./components/InventoryView";
import { OnboardingScreen } from "./components/OnboardingScreen";
import { ProfileView } from "./components/ProfileView";
import { PromptOverlay } from "./components/PromptOverlay";
import { SettingsView } from "./components/SettingsView";
import { SplashScreen } from "./components/SplashScreen";
import { StoreView } from "./components/StoreView";
import { TabBar, type View } from "./components/TabBar";
import { TradeView } from "./components/TradeView";
import { UpdateAvailableOverlay } from "./components/UpdateAvailableOverlay";
import { useOptimisticEquipped } from "./hooks/useOptimisticEquipped";
import { useTradeRequests } from "./hooks/useTradeRequests";
import { cn } from "./lib/utils";
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
    friends: {},
    pendingTradeRequest: null,
    pendingFriendRequest: null,
    incomingFriendRequests: [],
    outgoingFriendRequests: [],
    pendingDrops: [],
  });
  // Equipping is predicted locally so it lands instantly (see
  // useOptimisticEquipped). Overlaying it onto `state` here, rather than
  // threading it to each consumer, is what keeps the 3D herzie, the deck row,
  // the bank grid and the "inventory full" check from disagreeing for a frame.
  const {
    equipped: effectiveEquipped,
    toggleEquip,
    predictUnequip,
  } = useOptimisticEquipped(rawState.equipped);
  // Memoized on both inputs, each of which is itself identity-stable while its
  // content is unchanged — so this object only changes when something really
  // did, and an unrelated App re-render (a view switch, a local toggle) doesn't
  // hand every view a new `state` and re-render the lot.
  const state = useMemo(
    () => ({ ...rawState, equipped: effectiveEquipped }),
    [rawState, effectiveEquipped],
  );
  // Mounted here, at the root, rather than inside a view: trade invites have to
  // keep arriving while the window is hidden, and every view below is unmounted
  // or hidden at some point. See the hook for why the Rust-side fallback poll
  // stays.
  useTradeRequests(rawState.isOnline);
  const [view, setView] = useState<View>("home");
  const [tradeTarget, setTradeTarget] = useState<string | null>(null);
  const [incomingTradeId, setIncomingTradeId] = useState<string | null>(null);
  const [activityLog, setActivityLog] = useState<
    { time: string; message: string }[]
  >([]);
  const [deepLinkItem, setDeepLinkItem] = useState<string | null>(null);
  const [stageOverride, setStageOverride] = useState<number | null>(null);
  const [previewOnboarding, setPreviewOnboarding] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  /** Version the user dismissed the update overlay for; suppresses re-showing it. */
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<
    string | null
  >(null);
  /** Dev-only: shows the update overlay with a fake version (Settings → Debug). */
  const [testUpdateOverlay, setTestUpdateOverlay] = useState(false);
  const [updateInstallStatus, setUpdateInstallStatus] =
    useState<UpdateInstallStatus>({ kind: "idle" });
  /** Set by the "c" shortcut: focus/expand the chat once the home view shows it. */
  const [openChatRequested, setOpenChatRequested] = useState(false);
  /** "c" pressed mid-trade: open chat after the user confirms leaving the trade. */
  const openChatAfterLeaveRef = useRef(false);
  const [hasActiveEvent, setHasActiveEvent] = useState(false);
  const [hasActiveEventOverride, setHasActiveEventOverride] = useState(false);
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
    herzies.getState().then(setState);
    const unlistenState = herzies.onStateUpdate(setState);
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

  const inventoryFull = isBankFull(state.inventory, state.equipped);
  useEffect(() => {
    if (!inventoryFull) setDismissedInventoryFull(false);
  }, [inventoryFull]);

  // The tab only needs to know whether a song hunt is running right now, which
  // /events-active alone answers — and it's an Edge Function, so it's cheap and
  // fast. This used to also fetch /events/previous-hunt (a slow Vercel route)
  // purely "for parity with EventsView" and discard the result.
  const refreshEventIndicator = useCallback(() => {
    herzies
      .fetchActiveEvents()
      .then(({ events }) => {
        setHasActiveEvent(events.some((e) => e.type === "song_hunt"));
      })
      .catch(() => setHasActiveEvent(false));
  }, []);

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
      setView(v);
      return true;
    },
    [view, tradeActive],
  );

  /** "c" shortcut: go home and focus the chat. Mid-trade this routes through
   * the leave-trade confirmation like every other view switch. */
  const requestOpenChat = useCallback(() => {
    if (switchView("home")) {
      setOpenChatRequested(true);
    } else {
      openChatAfterLeaveRef.current = true;
    }
  }, [switchView]);

  // Tab keyboard shortcuts (advertised in the tab bar tooltips). Skipped
  // while typing in an input so chat/search fields don't switch views.
  useEffect(() => {
    if (!state.isOnline || !herzie || previewOnboarding) return;

    const shortcuts: Record<string, View> = {
      h: "home",
      i: "inventory",
      e: "events",
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

  const handleSpawnDebugDrop = () => {
    herzies.spawnDebugDrop().catch(() => {});
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
      addLog(result.message);
      if (result.success) setIgnoredFriendRequestId(pendingFriend.requestId);
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
          // Home supplies its own bottom breathing room (HomeView's now-playing
          // bar) so its artist-image background can reach the chat's top
          // border instead of stopping short of an outer margin. The viewer's
          // own profile shares the home slot but has no such bar, so it takes
          // the margin like every other view — otherwise it sits tighter to
          // the chat than the same profile opened from Social.
          (view !== "home" || !!selfProfile) && view !== "inventory" && "mb-2",
        )}
      >
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
              stageOverride={stageOverride}
              active={view === "home"}
              onOpenProfile={handleOpenSelfProfile}
              onOpenSettings={() => switchView("settings")}
              onActivity={addLog}
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
              inventory={state.inventory}
              currency={state.inventoryCurrency}
              equipped={state.equipped}
              onToggleEquip={toggleEquip}
              onPredictUnequip={predictUnequip}
              onLog={addLog}
              active={view === "inventory"}
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
            debugForceActive={hasActiveEventOverride}
            equipped={state.equipped}
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
              inventory={state.inventory}
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
            active={view === "store"}
            onLog={addLog}
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
            onTestUpdateAlert={() => setTestUpdateOverlay(true)}
            hasActiveEventOverride={hasActiveEventOverride}
            onToggleActiveEventOverride={() =>
              setHasActiveEventOverride((v) => !v)
            }
            onSpawnDebugDrop={handleSpawnDebugDrop}
            availableUpdate={availableUpdate}
            installStatus={updateInstallStatus}
            onInstallUpdate={handleInstallUpdate}
          />
        </div>
      </div>

      {herzie && view === "home" && !selfProfile && (
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
      )}

      {herzie && (
        <TabBar
          view={view}
          setView={switchView}
          hasActiveEvent={hasActiveEvent || hasActiveEventOverride}
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
              label: "Open Cards",
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

      {/* Transparent tint over the whole app; pointer-events-none so the ghost
          toggle and everything else stay interactive. The "music is not
          tracked" copy lives in the now-playing card in HomeView. */}
      {ghostMode && (
        <div className="pointer-events-none fixed inset-0 z-200 bg-black/30" />
      )}
    </div>
  );
}

const root = createRoot(document?.getElementById("root") ?? document.body);
root.render(<App />);
