"use client";

import { type CSSProperties, useEffect, useRef } from "react";
import { renderSky, type SceneryVariant } from "./scenery-renderer.js";

const FONT_FAMILY = "'SF Mono', 'Menlo', monospace";

interface Props {
  userId: string;
  isPlaying?: boolean;
  cols: number;
  /** Which scenery to display, driven by the equipped scenery item. */
  variant?: SceneryVariant;
  /** Font size in px for each character cell. */
  size?: number;
  /** Pause animation (e.g. when host indicates animate=false). */
  paused?: boolean;
  style?: CSSProperties;
  className?: string;
}

export function Sky({
  userId,
  isPlaying = false,
  cols,
  variant = null,
  size = 5,
  paused = false,
  style,
  className,
}: Props) {
  const ref = useRef<HTMLPreElement>(null);
  const cloudOffset = useRef(0);
  const twinkleFrame = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const render = () => {
      el.innerHTML = renderSky({
        userId,
        variant,
        isPlaying,
        cloudOffset: Math.floor(cloudOffset.current),
        twinkleFrame: twinkleFrame.current,
        cols,
      });
    };

    render();

    // Nothing equipped: render a blank sky once, no animation needed.
    if (paused || variant === null) return;

    const cloudId = setInterval(() => {
      cloudOffset.current += isPlaying ? 1.4 : 1;
      render();
    }, 100);

    const twinkleId = setInterval(() => {
      twinkleFrame.current += 1;
      render();
    }, 200);

    return () => {
      clearInterval(cloudId);
      clearInterval(twinkleId);
    };
  }, [userId, variant, isPlaying, paused, cols]);

  const lineH = size * 1.35;

  return (
    <pre
      ref={ref}
      className={className}
      style={{
        margin: 0,
        padding: 0,
        font: `${size}px ${FONT_FAMILY}`,
        lineHeight: `${lineH}px`,
        letterSpacing: 0,
        overflow: "hidden",
        pointerEvents: "none",
        ...style,
      }}
    />
  );
}
