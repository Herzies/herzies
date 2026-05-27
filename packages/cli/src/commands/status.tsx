import { Box, render, Text, useApp } from "ink";
import React, { useEffect, useState } from "react";
import { getNowPlaying, type NowPlayingInfo } from "../music/nowplaying.js";
import { checkOnline, type OnlineStatus } from "../storage/api.js";
import { isDaemonRunning } from "../storage/pid.js";
import { loadHerzie } from "../storage/state.js";
import { HerzieDisplay } from "../ui/HerzieDisplay.js";
import { StatsPanel } from "../ui/StatsPanel.js";

function StatusApp() {
  const { exit } = useApp();
  const herzie = loadHerzie();
  const daemonRunning = isDaemonRunning();
  const [nowPlaying, setNowPlaying] = useState<NowPlayingInfo | null>(null);
  const [online, setOnline] = useState<OnlineStatus | undefined>(undefined);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    Promise.all([getNowPlaying(), checkOnline()]).then(([np, isOnline]) => {
      setNowPlaying(np?.isPlaying ? np : null);
      setOnline(isOnline);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => exit(), 100);
    return () => clearTimeout(timer);
  }, [ready, exit]);

  if (!herzie) {
    return (
      <Box padding={1}>
        <Text color="yellow">
          No Herzie found! Run <Text bold>herzies hatch</Text> to get started.
        </Text>
      </Box>
    );
  }

  if (!ready) return null;

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="row">
        <Box flexDirection="column">
          <HerzieDisplay
            appearance={herzie.appearance}
            stage={herzie.stage}
            dancing={nowPlaying !== null}
          />
        </Box>
        <StatsPanel herzie={herzie} hideBonuses />
      </Box>

      {/* Now playing */}
      <Box marginTop={1}>
        {nowPlaying ? (
          <Text>
            <Text color="green" bold>
              ♪{" "}
            </Text>
            <Text bold>{nowPlaying.title}</Text>
            <Text dimColor> — {nowPlaying.artist}</Text>
          </Text>
        ) : (
          <Text dimColor>♪ No music playing</Text>
        )}
      </Box>

      {/* Daemon status */}
      <Box>
        {daemonRunning ? (
          <Text>
            <Text color="green">●</Text>
            <Text dimColor> listening in background</Text>
          </Text>
        ) : (
          <Text>
            <Text color="red">●</Text>
            <Text dimColor> not listening — run </Text>
            <Text bold>herzies start</Text>
            <Text dimColor> or </Text>
            <Text bold>herzies</Text>
          </Text>
        )}
        {online !== undefined && (
          <Text>
            {" "}
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
    </Box>
  );
}

export function runStatus() {
  render(<StatusApp />);
}
