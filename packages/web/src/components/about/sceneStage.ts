"use client";

import { HerzieStage } from "@herzies/shared/gl";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/** Drawn pixels per CSS pixel: finer than the stage's usual (1/4), so the
 * islands show finer detail. */
const PIXEL_SCALE = 1 / 3.5;
/** Finer still on phones (below Tailwind's `md`): their scenes are fewer
 * CSS pixels across, so at the desktop scale they'd turn out chunky. */
const PHONE_PIXEL_SCALE = 1 / 2.5;
const PHONE = "(max-width: 767px)";

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
    s.pixelScale = PIXEL_SCALE; // until the layout effect checks the screen
    return s;
  });
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const phone = window.matchMedia(PHONE);
    const update = () => {
      stage.pixelScale = phone.matches ? PHONE_PIXEL_SCALE : PIXEL_SCALE;
    };
    update();
    phone.addEventListener("change", update);
    stage.setHost(host.current, { fill: true });
    return () => {
      phone.removeEventListener("change", update);
      stage.dispose();
    };
  }, [stage]);
  return [stage, host];
}
