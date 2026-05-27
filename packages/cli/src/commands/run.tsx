import { createRequire } from "node:module";
import type {
  ActiveMultiplier,
  Herzie,
  PendingTradeRequest,
  Stage,
} from "@herzies/shared";
import { Box, render, Text, useApp, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";

const require = createRequire(import.meta.url);
const { version } = require("../../../package.json");

import { getItem } from "../art/items.js";
import { getNowPlaying, type NowPlayingInfo } from "../music/nowplaying.js";
import {
  apiCreateTrade,
  apiJoinTrade,
  checkOnline,
  type OnlineStatus,
} from "../storage/api.js";
import { ensureDaemonRunning } from "../storage/daemon.js";
import { isDaemonRunning } from "../storage/pid.js";
import {
  loadAndClearNotifications,
  loadHerzie,
  loadMultipliers,
  loadPendingTrade,
  saveHerzie,
  savePendingTrade,
} from "../storage/state.js";
import { FriendSelector } from "../ui/FriendSelector.js";
import { HerzieDisplay } from "../ui/HerzieDisplay.js";
import { InventoryView } from "../ui/InventoryView.js";
import { StatsPanel } from "../ui/StatsPanel.js";
import { TradingView } from "../ui/TradingView.js";

const REFRESH_INTERVAL = 3000;

const STAGE_NAMES: Record<Stage, string> = {
  1: "Baby",
  2: "Teen",
  3: "Champion",
};

interface EventMessage {
  text: string;
  color: string;
  time: number;
}

type View = "dashboard" | "inventory" | "friend-select" | "trading";

function RunApp() {
  const { exit } = useApp();
  const [herzie, setHerzie] = useState<Herzie | null>(null);
  const [currentTrack, setCurrentTrack] = useState<NowPlayingInfo | null>(null);
  const [daemonUp, setDaemonUp] = useState(false);
  const [events, setEvents] = useState<EventMessage[]>([]);
  const [tick, setTick] = useState(0);
  const [online, setOnline] = useState<OnlineStatus | undefined>(undefined);
  const [multipliers, setMultipliers] = useState<
    ActiveMultiplier[] | undefined
  >(undefined);
  const [pendingTrade, setPendingTrade] = useState<PendingTradeRequest | null>(
    null,
  );
  const [activeTradeId, setActiveTradeId] = useState<string | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  // View state
  const [view, setView] = useState<View>("dashboard");

  const startXp = useRef<number>(0);
  const prevLevel = useRef<number>(0);
  const prevStage = useRef<Stage>(1);
  const lastTradeNotified = useRef<string | null>(null);

  const pushEvent = (text: string, color: string) => {
    setEvents((prev) => [...prev.slice(-4), { text, color, time: Date.now() }]);
  };

  // Check for updates on mount
  useEffect(() => {
    fetch("https://registry.npmjs.org/herzies/latest")
      .then((r) => r.json())
      .then((data) => {
        if (data.version && data.version !== version) {
          setLatestVersion(data.version);
        }
      })
      .catch(() => {});
  }, []);

  // Auto-start daemon on mount
  useEffect(() => {
    const h = loadHerzie();
    if (!h) return;

    startXp.current = h.xp;
    prevLevel.current = h.level;
    prevStage.current = h.stage;
    setHerzie(h);

    if (!isDaemonRunning()) {
      ensureDaemonRunning();
    }
    setDaemonUp(true);
  }, []);

  // Refresh loop: re-read herzie state from disk + query now playing
  useEffect(() => {
    if (!daemonUp) return;

    const refresh = async () => {
      const [h, np, isOnline] = await Promise.all([
        Promise.resolve(loadHerzie()),
        getNowPlaying(),
        checkOnline(),
      ]);
      setOnline(isOnline);
      setMultipliers(
        isOnline === "online" ? (loadMultipliers() ?? undefined) : undefined,
      );

      if (h) {
        // Detect level-ups and evolutions from daemon's writes
        if (h.level > prevLevel.current) {
          pushEvent(`⬆ LEVEL UP! ${h.name} is now level ${h.level}!`, "yellow");
        }
        if (h.stage > prevStage.current) {
          pushEvent(
            `✨ ${h.name} EVOLVED to ${STAGE_NAMES[h.stage]} (Stage ${h.stage})!`,
            "magenta",
          );
        }
        prevLevel.current = h.level;
        prevStage.current = h.stage;
        setHerzie(h);
      }

      // Pick up notifications written by the daemon
      const notifications = loadAndClearNotifications();
      for (const n of notifications) {
        if (n.type === "item_granted" && n.itemId) {
          const def = getItem(n.itemId);
          const name = def?.name ?? n.itemId;
          pushEvent(`You received ${n.quantity ?? 1}x ${name}`, "cyan");
        } else {
          pushEvent(
            n.message,
            n.type === "event_complete" ? "magenta" : "white",
          );
        }
      }

      const playing = np?.isPlaying && np.title && np.volume > 0 ? np : null;
      setCurrentTrack(playing);

      // Check for pending trade requests (from daemon)
      if (isOnline === "online") {
        const pt = loadPendingTrade();
        setPendingTrade(pt);

        if (pt && pt.tradeId !== lastTradeNotified.current) {
          lastTradeNotified.current = pt.tradeId;
          pushEvent(
            `📦 ${pt.fromName} wants to trade! Press t to respond`,
            "green",
          );
          // Ring terminal bell
          process.stdout.write("\x07");
        }
      }
    };

    refresh();
    const interval = setInterval(refresh, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [daemonUp]);

  // Animated tick for the idle indicator
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Update terminal tab title
  useEffect(() => {
    const name = herzie?.name ?? "herzies";
    const status = currentTrack
      ? `♪ ${currentTrack.title} — ${currentTrack.artist}`
      : "idle";
    const conn = online && online !== "online" ? online : "";
    const parts = [name, status, conn].filter(Boolean);
    process.stdout.write(`\x1b]0;${parts.join(" · ")}\x07`);

    return () => {
      process.stdout.write(`\x1b]0;\x07`);
    };
  }, [herzie?.name, currentTrack, online]);

  useInput((_input, key) => {
    if (view !== "dashboard") return;

    if (key.escape || _input === "q" || (key.ctrl && _input === "c")) {
      exit();
    }
    if (_input === "b" && herzie) {
      herzie.boostUntil = Date.now() + 10000;
      saveHerzie(herzie);
    }
    if (_input === "i" && herzie) {
      setView("inventory");
    }
    if (_input === "t" && herzie && online === "online") {
      setView("friend-select");
    }
  });

  if (!herzie) {
    return (
      <Box padding={1}>
        <Text color="yellow">
          No Herzie found! Run <Text bold>herzies hatch</Text> to get started.
        </Text>
      </Box>
    );
  }

  // --- Inventory view ---
  if (view === "inventory") {
    return (
      <InventoryView
        herzie={herzie}
        onBack={() => setView("dashboard")}
        online={online}
      />
    );
  }

  // --- Friend selector for trading ---
  if (view === "friend-select") {
    return (
      <FriendSelector
        herzie={herzie}
        pendingTrade={pendingTrade}
        onSelect={async (friendCode) => {
          const result = await apiCreateTrade(friendCode);
          if (result) {
            setActiveTradeId(result.tradeId);
            setView("trading");
          } else {
            pushEvent("Failed to start trade.", "red");
            setView("dashboard");
          }
        }}
        onJoinTrade={async (tradeId) => {
          const ok = await apiJoinTrade(tradeId);
          if (ok) {
            setActiveTradeId(tradeId);
            savePendingTrade(null); // clear the pending trade
            setPendingTrade(null);
            setView("trading");
          } else {
            pushEvent("Failed to join trade.", "red");
            setView("dashboard");
          }
        }}
        onBack={() => setView("dashboard")}
      />
    );
  }

  // --- Trading view ---
  if (view === "trading" && activeTradeId) {
    return (
      <TradingView
        herzie={herzie}
        tradeId={activeTradeId}
        onDone={(message, color) => {
          if (color !== "yellow") pushEvent(message, color);
          setActiveTradeId(null);
          setView("dashboard");
        }}
      />
    );
  }

  // --- Dashboard view ---
  const sessionXp = Math.floor(herzie.xp - startXp.current);
  const dots = ".".repeat((tick % 3) + 1).padEnd(3);

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box>
        <Text bold color="magenta">
          ♫ herzies
        </Text>
        <Text dimColor> v{version}</Text>
        <Text dimColor> — {currentTrack ? "listening" : `idle${dots}`} </Text>
        {online !== undefined && (
          <Text>
            <Text color={online === "online" ? "green" : "red"}>
              [{online}]
            </Text>
            {online === "offline" && (
              <Text dimColor> xp syncs when back online</Text>
            )}
            {online === "unauthorized" && (
              <Text dimColor>
                {" "}
                run <Text bold>herzies login</Text> to re-authenticate
              </Text>
            )}
          </Text>
        )}
      </Box>

      {/* Main layout: Herzie art + stats */}
      <Box marginTop={1} flexDirection="row">
        <Box flexDirection="column" marginRight={2}>
          <HerzieDisplay
            appearance={herzie.appearance}
            stage={herzie.stage}
            dancing={currentTrack !== null}
          />
        </Box>

        <StatsPanel herzie={herzie} multipliers={multipliers} />
      </Box>

      {/* Now playing */}
      <Box marginTop={1} flexDirection="column">
        {currentTrack ? (
          <Box>
            <Text color="green" bold>
              ♪{" "}
            </Text>
            <Text bold>{currentTrack.title}</Text>
            <Text dimColor> — {currentTrack.artist}</Text>
            {sessionXp > 0 && (
              <Text dimColor> | +{sessionXp} XP this session</Text>
            )}
          </Box>
        ) : (
          <Text dimColor>♪ No music playing — play something to earn XP!</Text>
        )}
      </Box>

      {/* Event log */}
      {events.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {events
            .filter((e) => Date.now() - e.time < 30000)
            .map((e, i) => (
              <Text key={`${e.time}-${i}`} color={e.color}>
                {e.text}
              </Text>
            ))}
        </Box>
      )}

      {/* Update nudge */}
      {latestVersion && (
        <Box marginTop={1}>
          <Text color="yellow">
            Update available: v{version} → v{latestVersion} — run{" "}
            <Text bold>npm i -g herzies</Text>
          </Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>Press q to exit · i for inventory · t to trade</Text>
      </Box>
    </Box>
  );
}

export function runApp() {
  render(<RunApp />);
}
