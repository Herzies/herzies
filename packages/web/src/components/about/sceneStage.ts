"use client";

import { HerzieStage } from "@herzies/shared/gl";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/** Drawn pixels per CSS pixel: finer than the stage's usual (1/4), so the
 * islands show finer detail. */
const PIXEL_SCALE = 1 / 3.5;

/**
 * A scene's own herzie stage: one canvas, laid in the scene's box (the
 * returned ref, on a positioned element), so it scrolls with the page as
 * a picture does. The site's shared stage is one canvas fixed over the
 * window instead, moved by script, and on a phone it trails the scroll.
 * Six scenes are six WebGL contexts, well inside a browser's limit.
 */
export function useSceneStage(): [
  HerzieStage,
  RefObject<HTMLDivElement | null>,
] {
  const [stage] = useState(() => {
    const s = new HerzieStage();
    s.pixelScale = PIXEL_SCALE;
    return s;
  });
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    stage.setHost(host.current, { fill: true });
    return () => stage.dispose();
  }, [stage]);
  return [stage, host];
}
