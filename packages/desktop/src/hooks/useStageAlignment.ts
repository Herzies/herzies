import {
  type RefObject,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * Keeps the herzie's stage at the same height on Home and the Herzie view, so
 * the herzie doesn't jump when switching between them.
 *
 * Home positions its stage from the bottom (free space goes above it, so the
 * herzie stands on the level bar), while the Herzie view stacks from the top
 * (stage, deck, then the bag takes the rest). No fixed number lines those up,
 * so Home publishes how far below the top of its view the stage sits, and the
 * Herzie view pads its own stage down to match.
 *
 * Home can only be measured while it's on screen (hidden views are
 * display:none). The app opens on Home, so in practice the offset is known
 * before the Herzie view is first shown; until then the Herzie view keeps its
 * natural layout.
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

/** The Herzie view: how much space to put above its stage so it lines up
 * with Home's. */
export function useAlignToHomeStage(
  view: RefObject<HTMLElement | null>,
  stage: RefObject<HTMLElement | null>,
  active: boolean,
): number {
  const target = useSyncExternalStore(subscribe, () => homeStageOffset);
  const [pad, setPad] = useState(0);
  useLayoutEffect(() => {
    if (!active || target === null) return;
    const update = () => {
      const offset = measure(view.current, stage.current);
      if (offset === null) return;
      // Where the stage would sit with no padding, against where Home's is.
      setPad((current) => Math.max(0, target - (offset - current)));
    };
    update();
    if (!view.current) return;
    const observer = new ResizeObserver(update);
    observer.observe(view.current);
    return () => observer.disconnect();
  }, [active, target, view, stage]);
  return pad;
}
