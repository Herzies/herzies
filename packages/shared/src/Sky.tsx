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

    // Assigning innerHTML reparses the whole sky and rebuilds its DOM, which is
    // far more expensive than building the string. Stars only ever step on
    // twinkleFrame and clouds only on cloudOffset, so most ticks produce a
    // byte-identical string — compare first and skip the parse when nothing
    // moved.
    let lastHtml: string | null = null;
    const render = () => {
      const html = renderSky({
        userId,
        variant,
        isPlaying,
        cloudOffset: Math.floor(cloudOffset.current),
        twinkleFrame: twinkleFrame.current,
        cols,
      });
      if (html === lastHtml) return;
      lastHtml = html;
      el.innerHTML = html;
    };

    render();

    // Nothing equipped: render a blank sky once, no animation needed.
    if (paused || variant === null) return;

    // One timer, not two. renderSky reads cloudOffset for "clouds" and
    // twinkleFrame for "stars" and ignores the other entirely, so the variant
    // picks which counter advances — previously both timers ran for both
    // variants and each called the full render, so half the work drew a frame
    // identical to the one before it.
    const id =
      variant === "clouds"
        ? setInterval(() => {
            cloudOffset.current += isPlaying ? 1.4 : 1;
            render();
          }, 100)
        : setInterval(() => {
            twinkleFrame.current += 1;
            render();
          }, 200);

    return () => clearInterval(id);
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
