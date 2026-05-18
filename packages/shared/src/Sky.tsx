"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { renderSky } from "./scenery-renderer.js";

function useIsNight(): boolean {
  const [isNight, setIsNight] = useState(() => {
    if (typeof window === "undefined") return false;
    const h = new Date().getHours();
    return h >= 21 || h < 6;
  });

  useEffect(() => {
    const check = () => {
      const h = new Date().getHours();
      setIsNight(h >= 21 || h < 6);
    };
    const id = setInterval(check, 10 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  return isNight;
}

const FONT_FAMILY = "'SF Mono', 'Menlo', monospace";

interface Props {
  userId: string;
  isPlaying?: boolean;
  cols: number;
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
  size = 5,
  paused = false,
  style,
  className,
}: Props) {
  const ref = useRef<HTMLPreElement>(null);
  const isNight = useIsNight();
  const cloudOffset = useRef(0);
  const twinkleFrame = useRef(0);

  useEffect(() => {
    if (paused) return;
    const el = ref.current;
    if (!el) return;

    const render = () => {
      el.innerHTML = renderSky({
        userId,
        isNight,
        isPlaying,
        cloudOffset: Math.floor(cloudOffset.current),
        twinkleFrame: twinkleFrame.current,
        cols,
      });
    };

    render();

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
  }, [userId, isNight, isPlaying, paused, cols]);

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
