import {
  type ActiveMultiplier,
  type Herzie,
  levelProgress,
  type Stage,
  xpToNextLevel,
} from "@herzies/shared";
import { Box, Text } from "ink";
import React from "react";

interface Props {
  herzie: Herzie;
  /** Server-provided multipliers. Falls back to local calculation if not provided. */
  multipliers?: ActiveMultiplier[];
  /** Hide the bonuses section */
  hideBonuses?: boolean;
}

const STAGE_NAMES: Record<Stage, string> = {
  1: "Baby",
  2: "Teen",
  3: "Champion",
};

function XpBar({ progress, width = 20 }: { progress: number; width?: number }) {
  const filled = Math.round(progress * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return (
    <Text>
      <Text color="green">[{bar}]</Text>{" "}
      <Text color="yellow">{Math.round(progress * 100)}%</Text>
    </Text>
  );
}

export function StatsPanel({ herzie, multipliers, hideBonuses }: Props) {
  const progress = levelProgress(herzie);
  const toNext = xpToNextLevel(herzie);
  const totalHours = (herzie.totalMinutesListened / 60).toFixed(1);
  const activeMultipliers = multipliers ?? [];

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {/* Name & stage */}
      <Box>
        <Text bold color="cyan">
          {herzie.name}
        </Text>
        <Text dimColor>
          {" "}
          — {STAGE_NAMES[herzie.stage]} (Stage {herzie.stage})
        </Text>
      </Box>

      {/* Level + XP */}
      <Box marginTop={1}>
        <Text>
          <Text bold>Level:</Text> <Text color="yellow">{herzie.level}</Text>
        </Text>
      </Box>
      <Box>
        <Text bold>XP: </Text>
        <XpBar progress={progress} />
        <Text dimColor> ({Math.ceil(toNext)} to next)</Text>
      </Box>

      {/* Music stats */}
      <Box marginTop={1}>
        <Text bold>Music: </Text>
        <Text color="magenta">
          {totalHours}h ({Math.floor(herzie.totalMinutesListened)} min)
        </Text>
      </Box>

      {/* Friend code */}
      <Box>
        <Text bold>Code: </Text>
        <Text color="cyan">{herzie.friendCode}</Text>
        <Text dimColor>
          {" "}
          ({herzie.friendCodes.length} friendzie
          {herzie.friendCodes.length !== 1 ? "s" : ""}
          {herzie.friendCodes.length > 0
            ? `, +${Math.min(herzie.friendCodes.length, 20) * 2}% XP`
            : ""}
          )
        </Text>
      </Box>

      {/* Currency */}
      <Box>
        <Text bold>Balance: </Text>
        <Text color="yellow">${herzie.currency}</Text>
      </Box>

      {/* Streak */}
      {herzie.streakDays > 0 && (
        <Box>
          <Text bold>Streak: </Text>
          <Text color="yellow">
            {herzie.streakDays} day{herzie.streakDays !== 1 ? "s" : ""}
          </Text>
          <Text dimColor> (+{herzie.streakDays}% XP)</Text>
        </Box>
      )}

      {/* Active multipliers */}
      {!hideBonuses && !multipliers && (
        <Box marginTop={1}>
          <Text bold color="yellow">
            Bonuses:
          </Text>
          <Text dimColor> Log in to get bonuses</Text>
        </Box>
      )}
      {!hideBonuses && activeMultipliers.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="yellow">
            Bonuses:
          </Text>
          {activeMultipliers.map((m) => (
            <Box key={m.name}>
              <Text color="yellow"> ★ {m.name}</Text>
              <Text color="green"> +{Math.round(m.bonus * 100)}% XP</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
