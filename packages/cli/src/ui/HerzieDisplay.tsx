import type { HerzieAppearance, Stage } from "@herzies/shared";
import { Box, Text } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import { composeHerzie } from "../art/composer.js";

interface Props {
  appearance: HerzieAppearance;
  stage: Stage;
  dancing?: boolean;
}

const SWAY = [0, 0, 1, 1, 1, 0, 0, -1, -1, -1];
const BOUNCE = [0, 0, 0, -1, 0, 0, 0, 0, -1, 0];
const MAX_SWAY = 1;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

export function HerzieDisplay({ appearance, stage, dancing = false }: Props) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!dancing) {
      setFrame(0);
      return;
    }
    const t = setInterval(() => setFrame((f) => (f + 1) % SWAY.length), 300);
    return () => clearInterval(t);
  }, [dancing]);

  const art = composeHerzie(appearance, stage);
  const baseLines = useMemo(() => art.split("\n"), [art]);

  const maxVisibleWidth = useMemo(
    () => Math.max(...baseLines.map(visibleLength)),
    [baseLines],
  );
  const fixedWidth = maxVisibleWidth + MAX_SWAY * 2;
  const fixedHeight = baseLines.length + 1;

  if (!dancing) {
    return (
      <Box width={fixedWidth} height={fixedHeight} flexDirection="column">
        <Box paddingLeft={MAX_SWAY}>
          <Text>{art}</Text>
        </Box>
      </Box>
    );
  }

  const sway = SWAY[frame];
  const bounce = BOUNCE[frame];
  const padLeft = MAX_SWAY + sway;

  return (
    <Box width={fixedWidth} height={fixedHeight} flexDirection="column">
      {bounce >= 0 && <Text>{""}</Text>}
      <Box paddingLeft={padLeft}>
        <Text>{art}</Text>
      </Box>
      {bounce < 0 && <Text>{""}</Text>}
    </Box>
  );
}
