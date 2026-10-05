"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** How often a character says something, and how long each line stays up. */
export const LINE_EVERY_MS = 10_000;
export const LINE_VISIBLE_MS = 7_000;
/** Per character. ~28ms reads as deliberate rather than laggy. */
const TYPE_SPEED_MS = 28;

/** Typewriter reveal of `line`, restarted whenever a new line arrives.
 * `finish` shows the rest of it at once. */
export function useTypewriter(line: string | null): {
  typed: number;
  finish: () => void;
} {
  const [typed, setTyped] = useState(0);
  const lineRef = useRef(line);
  lineRef.current = line;
  // The interval stops itself once `typed` reaches the end, so jumping there
  // is all finishing takes.
  const finish = useCallback(() => {
    if (lineRef.current) setTyped(lineRef.current.length);
  }, []);
  useEffect(() => {
    if (!line) return;
    setTyped(0);
    const id = setInterval(() => {
      setTyped((n) => {
        if (n >= line.length) {
          clearInterval(id);
          return n;
        }
        return n + 1;
      });
    }, TYPE_SPEED_MS);
    return () => clearInterval(id);
  }, [line]);
  return { typed, finish };
}

/**
 * Cycles through `lines` while `active`: a new line every LINE_EVERY_MS, on
 * screen for LINE_VISIBLE_MS, never the same line twice in a row. `pick`
 * narrows the pool at speaking time (the boss filters by remaining HP) and
 * is read through a ref, so a caller re-rendering every second doesn't
 * restart the cycle mid-sentence.
 *
 * `advance` is the player clicking whoever's talking: a line still being
 * typed shows in full at once; otherwise the next line comes now, and the
 * cycle restarts from it so an automatic one doesn't follow straight after.
 */
export function useChatter(
  lines: readonly string[],
  active: boolean,
  pick?: (lines: readonly string[]) => readonly string[],
) {
  const [line, setLine] = useState<string | null>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const lastRef = useRef<string | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Speaks now and restarts the cycle; null while not active. */
  const speakNowRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!active) {
      setLine(null);
      return;
    }

    const speak = () => {
      if (hideRef.current) clearTimeout(hideRef.current);
      const eligible = pickRef.current
        ? pickRef.current(linesRef.current)
        : linesRef.current;
      if (eligible.length === 0) return;
      // Don't repeat the previous line unless it is the only one that fits.
      const fresh = eligible.filter((l) => l !== lastRef.current);
      const pool = fresh.length > 0 ? fresh : eligible;
      const chosen = pool[Math.floor(Math.random() * pool.length)];
      lastRef.current = chosen;
      setLine(chosen);
      hideRef.current = setTimeout(() => setLine(null), LINE_VISIBLE_MS);
    };

    speak();
    let cycle = setInterval(speak, LINE_EVERY_MS);
    speakNowRef.current = () => {
      speak();
      clearInterval(cycle);
      cycle = setInterval(speak, LINE_EVERY_MS);
    };
    return () => {
      speakNowRef.current = null;
      clearInterval(cycle);
      if (hideRef.current) clearTimeout(hideRef.current);
    };
  }, [active]);

  const { typed, finish } = useTypewriter(line);
  const typingRef = useRef(false);
  typingRef.current = line !== null && typed < line.length;
  const advance = useCallback(() => {
    if (typingRef.current) finish();
    else speakNowRef.current?.();
  }, [finish]);
  return { line, typed, advance };
}

/**
 * A white speech bubble pinned to the bottom of its (relative) container,
 * tail pointing up at whoever is talking. Drawn outside the ASCII canvas:
 * glyph art can't be read at this size.
 */
export function SpeechBubble({
  line,
  typed,
}: {
  line: string | null;
  typed: number;
}) {
  if (!line) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center">
      <div className="h-0 w-0 border-r-[5px] border-b-[5px] border-l-[5px] border-r-transparent border-b-white border-l-transparent" />
      <div className="relative max-w-full rounded bg-white px-1.5 py-1 text-left text-ui text-black">
        {/* The full line, invisible, reserves the bubble's final size so it
            doesn't grow or reflow as characters arrive — the typed text is
            overlaid on top. Without this the bubble jitters on every key. */}
        <span className="invisible" aria-hidden="true">
          {line}
        </span>
        <span className="absolute inset-0 px-1.5 py-1">
          {line.slice(0, typed)}
          {typed < line.length ? <span className="opacity-60">▍</span> : null}
        </span>
      </div>
    </div>
  );
}
