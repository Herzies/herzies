import { type RefObject, useLayoutEffect, useSyncExternalStore } from "react";

/**
 * Keeps the herzie's stage at the same height on Home and the Herzie view, so
 * the herzie doesn't jump when switching between them.
 *
 * Home positions its stage from the bottom (free space goes above it, so the
 * herzie stands on the level bar), while the Herzie view stacks from the top
 * (stage, deck, then the bag takes the rest). No fixed number lines those up,
 * so Home publishes how far below the top of its view the stage sits, and the
 * Herzie view positions its own stage (absolutely, behind the deck and bag)
 * at the same offset.
 *
 * Home can only be measured while it's on screen (hidden views are
 * display:none). The app opens on Home, so in practice the offset is known
 * before the Herzie view is first shown; until then the Herzie view puts its
 * stage straight under its header.
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
 * been on screen yet. The Herzie view places its own stage there. */
export function useHomeStageOffset(): number | null {
  return useSyncExternalStore(subscribe, () => homeStageOffset);
}
