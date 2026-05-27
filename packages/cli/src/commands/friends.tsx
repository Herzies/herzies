import type { HerzieProfile } from "@herzies/shared";
import { Box, render, Text, useApp } from "ink";
import React, { useEffect, useState } from "react";
import { addFriend, removeFriend } from "../core/friends.js";
import {
  apiAddFriend,
  apiLookupHerzies,
  apiRemoveFriend,
  isLoggedIn,
} from "../storage/api.js";
import { loadHerzie, saveHerzie } from "../storage/state.js";

function FriendsListApp() {
  const { exit } = useApp();
  const herzie = loadHerzie();
  const [profiles, setProfiles] = useState<Map<string, HerzieProfile>>(
    new Map(),
  );
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!herzie || herzie.friendCodes.length === 0) {
      setLoaded(true);
      return;
    }
    apiLookupHerzies(herzie.friendCodes).then((p) => {
      setProfiles(p);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (loaded) {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
  }, [loaded, exit]);

  if (!herzie) {
    return (
      <Box padding={1}>
        <Text color="yellow">
          No Herzie found! Run <Text bold>herzies hatch</Text> first.
        </Text>
      </Box>
    );
  }

  if (!loaded) {
    return (
      <Box padding={1}>
        <Text dimColor>Loading friendzies...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        Friendzies of {herzie.name}
      </Text>
      <Box marginTop={1}>
        <Text>
          Your code:{" "}
          <Text bold color="green">
            {herzie.friendCode}
          </Text>
        </Text>
      </Box>
      {herzie.friendCodes.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            No friendzies yet. Add one with: herzies friends add {"<code>"}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {herzie.friendCodes.map((code, i) => {
            const profile = profiles.get(code);
            return (
              <Text key={code}>
                {" "}
                {i + 1}. <Text color="cyan">{code}</Text>
                {profile ? (
                  <Text dimColor>
                    {" "}
                    — {profile.name} (Stage {profile.stage}, Lv.
                    {profile.level})
                  </Text>
                ) : (
                  <Text dimColor> — offline</Text>
                )}
              </Text>
            );
          })}
          <Box marginTop={1}>
            <Text dimColor>
              XP bonus: +{Math.min(herzie.friendCodes.length, 20) * 2}%
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

function ResultApp({
  message,
  success,
}: {
  message: string;
  success: boolean;
}) {
  const { exit } = useApp();

  React.useEffect(() => {
    const timer = setTimeout(() => exit(), 100);
    return () => clearTimeout(timer);
  }, [exit]);

  return (
    <Box padding={1}>
      <Text color={success ? "green" : "red"}>{message}</Text>
    </Box>
  );
}

export function runFriendsList() {
  render(<FriendsListApp />);
}

export async function runFriendsAdd(code: string) {
  const herzie = loadHerzie();
  if (!herzie) {
    render(
      <ResultApp
        message="No Herzie found! Run `herzies hatch` first."
        success={false}
      />,
    );
    return;
  }

  if (!isLoggedIn()) {
    render(
      <ResultApp
        message="You must be logged in to add friends. Run `herzies login` first."
        success={false}
      />,
    );
    return;
  }

  const result = await addFriend(herzie, code);
  if (result.success) {
    const synced = await apiAddFriend(
      herzie.friendCode,
      code.toUpperCase().trim(),
    );
    if (!synced) {
      // Undo local add
      herzie.friendCodes = herzie.friendCodes.filter(
        (c) => c !== code.toUpperCase().trim(),
      );
      render(
        <ResultApp
          message="Failed to sync friend. Check your connection and try again."
          success={false}
        />,
      );
      return;
    }
    saveHerzie(herzie);
  }
  render(<ResultApp message={result.message} success={result.success} />);
}

export async function runFriendsRemove(code: string) {
  const herzie = loadHerzie();
  if (!herzie) {
    render(
      <ResultApp
        message="No Herzie found! Run `herzies hatch` first."
        success={false}
      />,
    );
    return;
  }

  if (!isLoggedIn()) {
    render(
      <ResultApp
        message="You must be logged in to remove friends. Run `herzies login` first."
        success={false}
      />,
    );
    return;
  }

  const normalized = code.toUpperCase().trim();
  const result = removeFriend(herzie, code);
  if (result.success) {
    const synced = await apiRemoveFriend(herzie.friendCode, normalized);
    if (!synced) {
      // Re-add locally since remote failed
      herzie.friendCodes.push(normalized);
      render(
        <ResultApp
          message="Failed to sync removal. Check your connection and try again."
          success={false}
        />,
      );
      return;
    }
    saveHerzie(herzie);
  }
  render(<ResultApp message={result.message} success={result.success} />);
}
