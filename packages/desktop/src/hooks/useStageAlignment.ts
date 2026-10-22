import { type RefObject, useLayoutEffect, useSyncExternalStore } from "react";

/**
 * Where Home's herzie stage sits, so a profile shown in Home's place (the
 * player's own) stands its herzie in the same spot.
 *
 * Home positions its stage from the bottom (free space goes above it, so the
 * herzie stands on the level bar). No fixed number gives that position, so
 * Home publishes how far below the top of its view the stage sits.
 *
 * Home can only be measured while it's on screen (hidden views are
 * display:none); until then the offset is null and a profile centres its
 * herzie instead.
 */
let homeStageOffset: number | null = null;
const listeners = new Set<() => void>();

function setHomeStageOffset(offset: number) {
  if (offset === homeStageOffset) return;
  homeStageOffset = offset;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The stage's top, relative to its view's top. Null while hidden. */
function measure(
  view: HTMLElement | null,
  stage: HTMLElement | null,
): number | null {
  if (!view || !stage || view.offsetParent === null) return null;
  return Math.round(
    stage.getBoundingClientRect().top - view.getBoundingClientRect().top,
  );
}

/** Home: report where its stage sits, re-measuring whenever the view resizes. */
export function useReportHomeStage(
  view: RefObject<HTMLElement | null>,
  stage: RefObject<HTMLElement | null>,
  active: boolean,
) {
  useLayoutEffect(() => {
    if (!active || !view.current) return;
    const update = () => {
      const offset = measure(view.current, stage.current);
      if (offset !== null) setHomeStageOffset(offset);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(view.current);
    return () => observer.disconnect();
  }, [active, view, stage]);
}

/** Where Home's stage sits below the top of its view, or null if Home hasn't
 * been on screen yet. */
export function useHomeStageOffset(): number | null {
  return useSyncExternalStore(subscribe, () => homeStageOffset);
}
