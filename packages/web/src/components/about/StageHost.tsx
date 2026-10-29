"use client";

import { herzieStage } from "@herzies/shared/gl";
import { useLayoutEffect, useRef } from "react";

/** Drawn pixels per CSS pixel here: finer than the stage's usual (1/4), so
 * the islands show finer detail. */
const PIXEL_SCALE = 1 / 3.5;

/**
 * Where the page's herzies are drawn while it's open: a box covering its
 * nearest positioned ancestor (the page), which the herzie stage's canvas
 * moves into and scrolls with (see HerzieStage.setHost). A fixed canvas
 * lags a frame behind a phone's scrolling; this one doesn't. Its overflow
 * is clipped, so the canvas never makes the page taller.
 */
export function StageHost() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const before = herzieStage.pixelScale;
    herzieStage.pixelScale = PIXEL_SCALE;
    herzieStage.setHost(ref.current, { scrolls: true });
    return () => {
      herzieStage.setHost(null);
      herzieStage.pixelScale = before;
    };
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    />
  );
}
