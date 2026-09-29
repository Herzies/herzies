import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { COIN_GOLD, COIN_SHINE, COIN_SPIN } from "./FloatingCoins";

/** A visitor's own sparkle: the glyphs it cycles through, how fast, and how
 * each glyph is lit. */
type Sparkle = {
  frames: readonly string[];
  stepMs: number;
  colour: (glyph: string) => string;
  glow?: string;
  bold?: boolean;
  /** How many of the row's sparkle slots it fills (default: all). */
  count?: number;
  /** Default 0.8. */
  opacity?: number;
  /** Glyph size in px (default 10). */
  size?: number;
};

/** How a visitor's Town row is dressed: a backdrop in their colours, their
 * own sparkle, and text tints that stay readable on top of it. */
export type VisitorTheme = {
  background: string;
  sparkle?: Sparkle;
  /** Subtitle and countdown tint. */
  dim: string;
  /** "IN TOWN" — the theme's own accent, since status green fights some
   * backdrops (Henry's red most of all). */
  accent: string;
};

export const VISITOR_THEMES: Record<string, VisitorTheme> = {
  // Orphiez: deep sea blue, and no sparkles — just the colour.
  song_hunt: {
    background: "linear-gradient(90deg, #0c2233 0%, #10384a 55%, #0b1d2c 100%)",
    dim: "#8fbfcc",
    accent: "#7fe8ff",
  },
  // Good ol' George: old gold, and the same spinning coins as his stall.
  merchant: {
    background: "linear-gradient(90deg, #2c2008 0%, #4a3810 55%, #241a06 100%)",
    sparkle: {
      frames: COIN_SPIN,
      stepMs: 140,
      // Face-on catches the light; edge-on is the darker rim.
      colour: (glyph) => (glyph === "O" ? COIN_SHINE : COIN_GOLD),
      count: 4,
      opacity: 0.45,
      size: 8,
    },
    dim: "#cdb477",
    accent: "#ffd84a",
  },
  // The boss: dried-blood red, with black embers flaring at the edges.
  boss_fight: {
    background: "linear-gradient(90deg, #2a0505 0%, #5a0f0f 55%, #220404 100%)",
    sparkle: {
      frames: ["·", "•", "✦", "✦", "•", "·"],
      stepMs: 180,
      colour: () => "#000000",
      glow: "#ff2a2a99",
    },
    dim: "#d9a0a0",
    accent: "#ff9a8a",
  },
};

/** Legible over any backdrop: a hard one-pixel drop like the pixel art's. */
export const ROW_TEXT_SHADOW = "0 1px 0 rgba(0, 0, 0, 0.85)";

/** Scatters `count` sparkles along the row: one per equal-width band so
 * they never bunch up, jittered within it, alternating top and bottom edge
 * (from a random side) at a random inset, each with its own bob delay and
 * glyph phase. Rolled once per row, so they stay put while it's on screen. */
function scatter(count: number) {
  const band = 90 / count;
  const topFirst = Math.random() < 0.5;
  return Array.from({ length: count }, (_, i) => {
    const edge = (i % 2 === 0) === topFirst ? "top" : "bottom";
    return {
      left: `${2 + i * band + Math.random() * band * 0.7}%`,
      [edge]: `${2 + Math.random() * 22}%`,
      delay: Math.random() * 2.2,
      phase: Math.floor(Math.random() * 12),
    };
  });
}

/** A visitor's sparkles across their row: their own glyph cycle, bobbing
 * gently. Frozen when `paused`, so a hidden window costs no timer. */
export function VisitorSparkles({
  sparkle,
  paused,
}: {
  sparkle: Sparkle;
  paused: boolean;
}) {
  const [frame, setFrame] = useState(0);
  const [slots] = useState(() => scatter(sparkle.count ?? 7));

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setFrame((f) => f + 1), sparkle.stepMs);
    return () => clearInterval(id);
  }, [paused, sparkle.stepMs]);

  return (
    <span className="pointer-events-none absolute inset-0" aria-hidden>
      {slots.map(({ delay, phase, ...pos }, i) => {
        const glyph = sparkle.frames[(frame + phase) % sparkle.frames.length];
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed per-row set
            key={i}
            className={cn(
              "absolute font-mono leading-none",
              sparkle.bold && "font-bold",
            )}
            style={{
              ...pos,
              color: sparkle.colour(glyph),
              opacity: sparkle.opacity ?? 0.8,
              fontSize: sparkle.size ?? 10,
              textShadow: sparkle.glow ? `0 0 3px ${sparkle.glow}` : "none",
              animation: `drop-float 2.2s ease-in-out ${delay}s infinite`,
              animationPlayState: paused ? "paused" : "running",
            }}
          >
            {glyph}
          </span>
        );
      })}
    </span>
  );
}
