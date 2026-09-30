import { useEffect, useState } from "react";

/** A coin turning on its vertical axis, one glyph per step: face-on, then
 * narrowing to the edge and back. */
export const COIN_SPIN = ["O", "0", "o", "|", "o", "0"];
const SPIN_STEP_MS = 140;

export const COIN_GOLD = "#F5C518";
export const COIN_SHINE = "#FFF4B8";

/** Where each coin hangs, as % of the stage, ringed around George rather
 * than over his face. Per coin: size (px), bob delay/duration (s), and a
 * spin offset so they don't all turn in lockstep. */
const COINS = [
  { x: 14, y: 18, size: 13, delay: 0, dur: 3.2, spin: 0 },
  { x: 84, y: 14, size: 11, delay: 0.8, dur: 2.7, spin: 2 },
  { x: 8, y: 48, size: 10, delay: 1.6, dur: 3.6, spin: 4 },
  { x: 91, y: 44, size: 14, delay: 0.4, dur: 3.0, spin: 1 },
  { x: 22, y: 74, size: 12, delay: 1.2, dur: 2.9, spin: 3 },
  { x: 78, y: 70, size: 10, delay: 2.0, dur: 3.4, spin: 5 },
  { x: 30, y: 6, size: 9, delay: 1.0, dur: 3.8, spin: 2 },
  { x: 68, y: 4, size: 12, delay: 2.4, dur: 3.1, spin: 4 },
];

/**
 * Gold coins bobbing around Good ol' George. An overlay of positioned glyphs
 * rather than something drawn into the herzie canvas: the creature renderer
 * has no notion of free-floating props, and a few spans are far cheaper than
 * teaching it one. Place inside a `relative` container the size of the stage.
 */
export function FloatingCoins({ paused }: { paused: boolean }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setStep((s) => s + 1), SPIN_STEP_MS);
    return () => clearInterval(id);
  }, [paused]);

  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      {COINS.map((coin) => {
        const glyph = COIN_SPIN[(step + coin.spin) % COIN_SPIN.length];
        return (
          <span
            key={`${coin.x}-${coin.y}`}
            className="absolute font-mono font-bold"
            style={{
              left: `${coin.x}%`,
              top: `${coin.y}%`,
              fontSize: coin.size,
              lineHeight: 1,
              // Face-on catches the light; edge-on is the darker rim.
              color: glyph === "O" ? COIN_SHINE : COIN_GOLD,
              textShadow: `0 0 4px ${COIN_GOLD}66`,
              animation: `coin-float ${coin.dur}s ease-in-out ${coin.delay}s infinite`,
              animationPlayState: paused ? "paused" : "running",
            }}
          >
            {glyph}
          </span>
        );
      })}
    </div>
  );
}
