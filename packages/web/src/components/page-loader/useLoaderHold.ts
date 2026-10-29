"use client";

import { useEffect } from "react";
import { hold } from "./store";

/** After the next paint: two frames, so whatever was just committed is on
 * screen before the overlay moves. Returns a cancel. */
export function afterPaint(fn: () => void) {
  let inner = 0;
  const outer = requestAnimationFrame(() => {
    inner = requestAnimationFrame(fn);
  });
  return () => {
    cancelAnimationFrame(outer);
    cancelAnimationFrame(inner);
  };
}

/**
 * Keeps the page loader up while `waiting` (the page's content is still on
 * its way), and lets go once what replaced it has painted. It only keeps
 * up an overlay that's already there; see hold() in store.ts.
 */
export function useLoaderHold(waiting: boolean) {
  useEffect(() => {
    if (!waiting) return;
    const release = hold();
    return () => {
      afterPaint(release);
    };
  }, [waiting]);
}
