import { useSyncExternalStore } from "react";

/**
 * Whether Shift is held, for previews that show more while it is (comparing
 * a bag card with what's worn). Watched for good from the first ask, so it's
 * still known when the pointer moves from one card's preview to the next.
 * Keys say when it goes down or up; the pointer's own events (which carry
 * the modifier) catch a Shift pressed while another window had the keys.
 * Leaving the window lets go of it: a Shift released elsewhere never comes
 * back as a keyup.
 */

let held = false;
let watching = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (next === held) return;
  held = next;
  for (const l of listeners) l();
}

function watch() {
  if (watching) return;
  watching = true;
  const fromEvent = (e: KeyboardEvent | PointerEvent) => set(e.shiftKey);
  window.addEventListener("keydown", fromEvent);
  window.addEventListener("keyup", fromEvent);
  window.addEventListener("pointermove", fromEvent, { passive: true });
  window.addEventListener("blur", () => set(false));
}

function subscribe(l: () => void) {
  watch();
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useShiftHeld(): boolean {
  return useSyncExternalStore(subscribe, () => held);
}
