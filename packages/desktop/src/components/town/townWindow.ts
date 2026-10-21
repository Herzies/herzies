import { isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

/**
 * Whether the window is to be the Town's bigger one (toggled with its
 * button or Z). Only while the Town's world is on screen: main.tsx shrinks
 * the window everywhere else, and grows it again on the way back. Small
 * each time the app starts.
 */
let expanded = false;
const listeners = new Set<() => void>();

/** Whether there's a window to resize (not in a plain browser). */
export const canExpandTown = isTauri();

export function toggleTownExpanded(): void {
  if (!canExpandTown) return;
  expanded = !expanded;
  for (const l of listeners) l();
}

export function useTownExpanded(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => expanded,
  );
}
