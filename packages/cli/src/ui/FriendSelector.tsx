import type {
  Herzie,
  HerzieProfile,
  PendingTradeRequest,
} from "@herzies/shared";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { apiLookupHerzies } from "../storage/api.js";

interface Props {
  herzie: Herzie;
  pendingTrade: PendingTradeRequest | null;
  onSelect: (friendCode: string) => void;
  onJoinTrade: (tradeId: string) => void;
  onBack: () => void;
}

export function FriendSelector({
  herzie,
  pendingTrade,
  onSelect,
  onJoinTrade,
  onBack,
}: Props) {
  const [selected, setSelected] = useState(0);
  const [friends, setFriends] = useState<Map<string, HerzieProfile> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiLookupHerzies(herzie.friendCodes).then((result) => {
      setFriends(result);
      setLoading(false);
    });
  }, [herzie.friendCodes]);

  const friendList = friends
    ? herzie.friendCodes
        .map((code) => friends.get(code))
        .filter((f): f is HerzieProfile => f !== null && f !== undefined)
    : [];

  // If there's a pending trade, add it as the first option
  const hasPending = pendingTrade !== null;
  const totalItems = (hasPending ? 1 : 0) + friendList.length;

  useInput((_input, key) => {
    if (key.escape || _input === "q") {
      onBack();
      return;
    }

    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(totalItems - 1, s + 1));
    }
    if (key.return && totalItems > 0) {
      if (hasPending && selected === 0) {
        onJoinTrade(pendingTrade!.tradeId);
      } else {
        const friendIdx = hasPending ? selected - 1 : selected;
        if (friendIdx < friendList.length) {
          onSelect(friendList[friendIdx].friendCode);
        }
      }
    }
  });

  if (loading) {
    return (
      <Box padding={1}>
        <Text dimColor>Loading friends...</Text>
      </Box>
    );
  }

  if (totalItems === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">
          No friends to trade with. Add some friends first!
        </Text>
        <Box marginTop={1}>
          <Text dimColor>Press q to go back</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="magenta">
        Select a friend to trade with
      </Text>

      <Box marginTop={1} flexDirection="column">
        {hasPending && (
          <Box>
            <Text color={selected === 0 ? "yellow" : undefined}>
              {selected === 0 ? "▸ " : "  "}
            </Text>
            <Text color="green" bold>
              {pendingTrade!.fromName} wants to trade!
            </Text>
            <Text dimColor> ({pendingTrade!.fromFriendCode})</Text>
          </Box>
        )}

        {friendList.map((friend, i) => {
          const idx = hasPending ? i + 1 : i;
          const isSelected = idx === selected;
          return (
            <Box key={friend.friendCode}>
              <Text color={isSelected ? "yellow" : undefined}>
                {isSelected ? "▸ " : "  "}
              </Text>
              <Text bold>{friend.name}</Text>
              <Text dimColor>
                {" "}
                ({friend.friendCode}) Lv.{friend.level}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate · Enter to select · q to go back</Text>
      </Box>
    </Box>
  );
}
