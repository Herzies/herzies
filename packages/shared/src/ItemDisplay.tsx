"use client";

import { useEffect, useState } from "react";
import type { ItemDef } from "./items.js";

interface Props {
  item: ItemDef;
  size?: number;
  animate?: boolean;
}

export function ItemDisplay({ item, size = 10, animate = true }: Props) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!animate || item.frames.length <= 1) return;
    const id = setInterval(
      () => setFrame((f) => (f + 1) % item.frames.length),
      80,
    );
    return () => clearInterval(id);
  }, [animate, item.frames.length]);

  const lines = item.frames[frame] ?? item.frames[0];

  return (
    <pre
      style={{
        fontSize: size,
        lineHeight: 1.35,
        margin: 0,
        fontFamily: "'SF Mono', 'Menlo', monospace",
        userSelect: "none",
      }}
    >
      {lines.map((line, i) => (
        <span
          key={i}
          dangerouslySetInnerHTML={{ __html: line }}
          style={{ display: "block" }}
        />
      ))}
    </pre>
  );
}
