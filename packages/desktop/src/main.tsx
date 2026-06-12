import "./globals.css";
import type { HerzieProfile } from "@herzies/shared";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { TabBar, type View } from "./components/TabBar";
import { TradeView } from "./components/TradeView";
import { UpdateAvailableOverlay } from "./components/UpdateAvailableOverlay";
import { cn } from "./lib/utils";
import {
  type AppState,
  checkForUpdate,
  herzies,
  useWindowFocused,
} from "./tauri-bridge";

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h

function App() {
  const [state, setState] = useState<AppState>({
    herzie: null,
    nowPlaying: null,
    multipliers: null,
    isOnline: false,
    isConnected: true,
    version: "",
    equipped: [],
    chatMessages: [],
    inventory: null,
    inventoryCurrency: 0,
    friends: {},
    pendingTradeRequest: null,
    pendingFriendRequest: null,
    incomingFriendRequests: [],
    outgoingFriendRequests: [],
  });
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
  /** Set by the "c" shortcut: focus/expand the chat once the home view shows it. */
  const [openChatRequested, setOpenChatRequested] = useState(false);
  /** "c" pressed mid-trade: open chat after the user confirms leaving the trade. */
  const openChatAfterLeaveRef = useRef(false);
  const [hasActiveEvent, setHasActiveEvent] = useState(false);
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
  const focused = useWindowFocused();

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

  const refreshEventIndicator = useCallback(() => {
    Promise.all([herzies.fetchActiveEvents(), herzies.fetchPreviousHunt()])
      .then(([active, previous]) => {
        const hunt = active.events.find((e) => e.type === "song_hunt");
        const previousHunt = previous.events.find(
          (e) => e.type === "song_hunt",
        );
        // Sparkle only when there is an active song hunt.
        // Keep previous hunt lookup for parity with EventsView data flow.
        void previousHunt;
        setHasActiveEvent(!!hunt);
      })
      .catch(() => setHasActiveEvent(false));
  }, []);

  useEffect(() => {
    if (!state.isOnline) return;
    refreshEventIndicator();
  }, [state.isOnline, refreshEventIndicator]);

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
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const update = await checkForUpdate();
      if (cancelled) return;
      if (!update) {
        setAvailableUpdate(null);
        return;
      }
      setAvailableUpdate(update);
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
      s: "settings",
    };

    const handler = (event: KeyboardEvent) => {
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
      className="flex h-screen flex-col px-3 pt-3 pb-1"
    >
      <div className="mb-2 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          className={cn(
            "min-h-0 flex-1 flex-col",
            view === "home" ? "flex" : "hidden",
          )}
        >
          {selfProfile ? (
            <ProfileView
              profile={selfProfile}
              isSelf
              isFriend
              stageOverride={stageOverride}
              onBack={() => setSelfProfile(null)}
              onTrade={() => {}}
              onAdd={() => {}}
              onRemove={() => {}}
            />
          ) : (
            <HomeView
              state={state}
              stageOverride={stageOverride}
              onOpenProfile={handleOpenSelfProfile}
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
          <EventsView eventsTabVisible={view === "events"} />
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
            view === "settings" ? "flex" : "hidden",
          )}
        >
          <SettingsView
            state={state}
            stageOverride={stageOverride}
            onStageOverride={setStageOverride}
            onPreviewOnboarding={() => setPreviewOnboarding(true)}
            onTestUpdateAlert={() => setTestUpdateOverlay(true)}
            availableUpdate={availableUpdate}
            onUpdateInstalled={() => setAvailableUpdate(null)}
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
          onActivity={addLog}
        />
      )}

      {herzie && (
        <TabBar
          view={view}
          setView={switchView}
          hasActiveEvent={hasActiveEvent}
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
            onUpdate={() => {
              setDismissedUpdateVersion(availableUpdate.version);
              switchView("settings");
            }}
            onLater={() => setDismissedUpdateVersion(availableUpdate.version)}
          />
        )}

      {testUpdateOverlay && (
        <UpdateAvailableOverlay
          version="9.9.9-test"
          onUpdate={() => setTestUpdateOverlay(false)}
          onLater={() => setTestUpdateOverlay(false)}
        />
      )}
    </div>
  );
}

const root = createRoot(document?.getElementById("root") ?? document.body);
root.render(<App />);
