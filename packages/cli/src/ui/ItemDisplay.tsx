import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { getItem } from "../art/items.js";

interface Props {
  itemId: string;
  animate?: boolean;
}

const FRAME_MS = 80;

export function ItemDisplay({ itemId, animate = false }: Props) {
  const item = getItem(itemId);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!animate || !item) return;
    const t = setInterval(
      () => setFrame((f) => (f + 1) % item.frames.length),
      FRAME_MS,
    );
    return () => clearInterval(t);
  }, [animate, item]);

  if (!item) return null;

  const lines = animate ? item.frames[frame] : item.art;

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}
