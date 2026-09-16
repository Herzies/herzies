"use client";

import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  contentBounds,
  drawFrameCells,
  fitMetrics,
  parseAsciiFrames,
  widestFrameIndex,
} from "./item-canvas.js";
import type { ItemDef } from "./items.js";

interface Props {
  item: ItemDef;
  /** Fixed square (px) footprint every preview renders within. Default: 120. */
  box?: number;
  /** Cycle ASCII animation frames. Default: true. */
  animate?: boolean;
  /** Stop animation to save CPU while the host is hidden / unfocused. */
  paused?: boolean;
  /**
   * Hold on one static frame instead of animating (overrides `animate`).
   * `"front"` picks the widest frame — the card facing the camera square-on,
   * as opposed to frame 0, which is nearest edge-on (see `generateFrames` in
   * items.ts) and reads as the item having vanished.
   */
  frame?: number | "front";
  ariaLabel?: string;
  wrapperStyle?: CSSProperties;
}

/**
 * Item preview: renders the item's baked ASCII art, content-cropped and fit
 * into a fixed `box` square so every item shares a consistent footprint and
 * fills either the width or the height.
 */
export function ItemPreview({
  item,
  box = 120,
  animate = true,
  paused = false,
  frame,
  ariaLabel,
  wrapperStyle,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const cellFrames = useMemo(
    () => parseAsciiFrames(item.frames),
    [item.frames],
  );
  const staticFrame = frame === "front" ? widestFrameIndex(cellFrames) : frame;
  const [frameIdx, setFrameIdx] = useState(staticFrame ?? 0);
  const bounds = useMemo(() => contentBounds(cellFrames), [cellFrames]);
  const metrics = useMemo(() => fitMetrics(bounds, box), [bounds, box]);

  useEffect(() => {
    if (staticFrame !== undefined) setFrameIdx(staticFrame);
  }, [staticFrame]);

  useEffect(() => {
    if (
      staticFrame !== undefined ||
      paused ||
      !animate ||
      cellFrames.length <= 1
    )
      return;
    const id = setInterval(
      () => setFrameIdx((f) => (f + 1) % cellFrames.length),
      80,
    );
    return () => clearInterval(id);
  }, [animate, cellFrames.length, paused, staticFrame]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawFrameCells(ctx, cellFrames[frameIdx] ?? cellFrames[0], bounds, metrics);
  }, [frameIdx, cellFrames, bounds, metrics]);

  return (
    <div
      style={{
        width: box,
        height: box,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        userSelect: "none",
        ...wrapperStyle,
      }}
    >
      <canvas
        ref={canvasRef}
        width={metrics.canvasW}
        height={metrics.canvasH}
        style={{
          width: metrics.canvasW,
          height: metrics.canvasH,
          imageRendering: "pixelated",
        }}
        aria-label={ariaLabel ?? item.name}
      />
    </div>
  );
}
