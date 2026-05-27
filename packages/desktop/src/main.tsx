import "./globals.css";
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
import { IncomingTradeOverlay } from "./components/IncomingTradeOverlay";
import { InventoryView } from "./components/InventoryView";
import { OnboardingScreen } from "./components/OnboardingScreen";
import { SettingsView } from "./components/SettingsView";
import { SplashScreen } from "./components/SplashScreen";
import { TabBar, type View } from "./components/TabBar";
import { TradeView } from "./components/TradeView";
import { cn } from "./lib/utils";
import {
  type AppState,
  checkForUpdate,
  herzies,
  useWindowFocused,
} from "./tauri-bridge";

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

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
  const [hasActiveEvent, setHasActiveEvent] = useState(false);
  const [chatProfileCode, setChatProfileCode] = useState<string | null>(null);
  const [ignoredIncomingTradeId, setIgnoredIncomingTradeId] = useState<
    string | null
  >(null);
  const [incomingTradeDeclineBusy, setIncomingTradeDeclineBusy] =
    useState(false);
  /** Bumps when a trade session ends or a new one starts so TradeView remounts (clears stale tradeId). */
  const [tradeViewGeneration, setTradeViewGeneration] = useState(0);
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
        setTradeViewGeneration((g) => g + 1);
        setIncomingTradeId(tradeId);
        setTradeTarget(null);
        setView("trade");
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
  }, [addLog]);

  useEffect(() => {
    if (!state.pendingTradeRequest) {
      setIgnoredIncomingTradeId(null);
      setIncomingTradeDeclineBusy(false);
    }
  }, [state.pendingTradeRequest]);

  const refreshEventIndicator = useCallback(() => {
    Promise.all([herzies.fetchActiveEvents(), herzies.fetchPreviousHunt()])
      .then(([active, previous]) => {
        const hunt = active.events.find((e) => e.type === "song_hunt");
        const previousHunt = previous.events[0] ?? null;
        // Match EventsView: active hunt, or between-hunts countdown content
        setHasActiveEvent(!!hunt || (!hunt && !!previousHunt));
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

  // Check for updates on launch and every 6h. Fires a system notification
  // once per detected version so the user knows even if the window is hidden.
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

  if (!state.isOnline) {
    return <SplashScreen />;
  }

  if (!herzie) {
    return <OnboardingScreen />;
  }

  if (previewOnboarding) {
    return <OnboardingScreen onClose={() => setPreviewOnboarding(false)} />;
  }

  const switchView = (v: View) => {
    if (v !== "inventory") setDeepLinkItem(null);
    if (v !== "trade") {
      setIncomingTradeId(null);
      setTradeTarget(null);
    }
    setView(v);
  };

  const handleStartTrade = (code: string) => {
    setTradeTarget(code);
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
          <HomeView state={state} stageOverride={stageOverride} />
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
              onStartTrade={handleStartTrade}
              stageOverride={stageOverride}
              openProfileCode={chatProfileCode}
              onProfileOpened={() => setChatProfileCode(null)}
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
              onClose={() => {
                setTradeTarget(null);
                setIncomingTradeId(null);
                setTradeViewGeneration((g) => g + 1);
                setView("friends");
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
            availableUpdate={availableUpdate}
            onUpdateInstalled={() => setAvailableUpdate(null)}
          />
        </div>
      </div>

      {herzie && view === "home" && (
        <ChatPanel
          activityLog={activityLog}
          isOnline={state.isOnline}
          messages={state.chatMessages}
          inventory={state.inventory}
          friends={state.friends}
          herzie={herzie}
          nowPlaying={state.nowPlaying}
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

      {herzie && showIncomingTradeOverlay && pendingIncoming && (
        <IncomingTradeOverlay
          request={pendingIncoming}
          busy={incomingTradeDeclineBusy ? "ignore" : null}
          onJoin={handleJoinIncomingTrade}
          onIgnore={handleIgnoreIncomingTrade}
        />
      )}
    </div>
  );
}

const root = createRoot(document?.getElementById("root") ?? document.body);
root.render(<App />);
