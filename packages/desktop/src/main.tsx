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
  }, []);

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
    switchView("trade");
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
          <EventsView />
        </div>

        {herzie && (
          <div
            className={cn(
              "min-h-0 flex-1 flex-col",
              view === "trade" ? "flex" : "hidden",
            )}
          >
            <TradeView
              herzie={herzie}
              initialTarget={tradeTarget}
              initialTradeId={incomingTradeId}
              inventory={state.inventory}
              currency={state.inventoryCurrency}
              onClose={() => {
                setTradeTarget(null);
                setIncomingTradeId(null);
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
          herzie={herzie}
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
    </div>
  );
}

const root = createRoot(document?.getElementById("root") ?? document.body);
root.render(<App />);
