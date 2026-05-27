import type { ColorScheme, HerzieAppearance, Stage } from "@herzies/shared";
import { Box, render, Text, useApp, useInput } from "ink";
import React, { useState } from "react";
import { HerzieDisplay } from "../ui/HerzieDisplay.js";

const COLOR_SCHEMES: ColorScheme[] = [
  "pink",
  "blue",
  "green",
  "purple",
  "orange",
  "yellow",
  "cyan",
  "red",
];

interface Field {
  key: keyof HerzieAppearance;
  label: string;
  max: number;
  /** Which stages this field applies to */
  stages: Stage[];
}

const FIELDS: Field[] = [
  { key: "headIndex", label: "Head", max: 4, stages: [1, 2, 3] },
  { key: "eyesIndex", label: "Eyes", max: 6, stages: [1, 2, 3] },
  { key: "mouthIndex", label: "Mouth", max: 5, stages: [1, 2, 3] },
  { key: "accessoryIndex", label: "Accessory", max: 6, stages: [1, 2, 3] },
  { key: "limbsIndex", label: "Limbs", max: 4, stages: [2] },
  { key: "bodyIndex", label: "Body", max: 4, stages: [3] },
  { key: "legsIndex", label: "Legs", max: 4, stages: [3] },
  {
    key: "colorScheme",
    label: "Color",
    max: COLOR_SCHEMES.length,
    stages: [1, 2, 3],
  },
];

function wrap(n: number, max: number): number {
  return ((n % max) + max) % max;
}

function PreviewApp() {
  const { exit } = useApp();
  const [stage, setStage] = useState<Stage>(1);
  const [cursor, setCursor] = useState(0);
  const [appearance, setAppearance] = useState<HerzieAppearance>({
    headIndex: 0,
    eyesIndex: 0,
    mouthIndex: 0,
    accessoryIndex: 0,
    limbsIndex: 0,
    bodyIndex: 0,
    legsIndex: 0,
    colorScheme: "pink",
  });

  const activeFields = FIELDS.filter((f) => f.stages.includes(stage));

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
      return;
    }

    // Stage switching
    if (input === "1") {
      setStage(1);
      setCursor(0);
      return;
    }
    if (input === "2") {
      setStage(2);
      setCursor(0);
      return;
    }
    if (input === "3") {
      setStage(3);
      setCursor(0);
      return;
    }

    // Navigate fields
    if (key.upArrow) {
      setCursor((c) => wrap(c - 1, activeFields.length));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => wrap(c + 1, activeFields.length));
      return;
    }

    // Cycle values
    const field = activeFields[cursor];
    if (!field) return;
    const delta =
      key.rightArrow || input === "="
        ? 1
        : key.leftArrow || input === "-"
          ? -1
          : 0;
    if (delta === 0) return;

    setAppearance((a) => {
      if (field.key === "colorScheme") {
        const idx = COLOR_SCHEMES.indexOf(a.colorScheme);
        return {
          ...a,
          colorScheme: COLOR_SCHEMES[wrap(idx + delta, COLOR_SCHEMES.length)],
        };
      }
      const val = a[field.key] as number;
      return { ...a, [field.key]: wrap(val + delta, field.max) };
    });
  });

  const safeIdx = Math.min(cursor, activeFields.length - 1);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="magenta">
        herzies preview
      </Text>
      <Text dimColor>
        Stage: 1/2/3 | Up/Down: select field | Left/Right: cycle value | q: quit
      </Text>

      <Box marginTop={1} flexDirection="row">
        {/* Left: herzie art */}
        <Box flexDirection="column" marginRight={3}>
          <HerzieDisplay
            appearance={appearance}
            stage={stage}
            dancing={false}
          />
        </Box>

        {/* Right: controls */}
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>Stage: </Text>
            {([1, 2, 3] as Stage[]).map((s) => (
              <Text
                key={`stage-${s}`}
                color={s === stage ? "cyan" : undefined}
                bold={s === stage}
                dimColor={s !== stage}
              >
                {" "}
                {s}{" "}
              </Text>
            ))}
          </Box>

          {activeFields.map((field, i) => {
            const selected = i === safeIdx;
            const value =
              field.key === "colorScheme"
                ? appearance.colorScheme
                : `${appearance[field.key]}`;
            return (
              <Box key={field.key}>
                <Text color={selected ? "yellow" : undefined} bold={selected}>
                  {selected ? ">" : " "} {field.label.padEnd(10)} {value}
                </Text>
              </Box>
            );
          })}

          <Box marginTop={1} flexDirection="column">
            <Text dimColor>
              {JSON.stringify({ appearance, stage }, null, 2)}
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

export function runPreview() {
  render(<PreviewApp />);
}

// Allow running directly: node dist/src/commands/preview.js
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) runPreview();
