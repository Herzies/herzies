import { isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

/** Whether there's a window to resize (not in a plain browser). */
export const canExpandTown = isTauri();

const KEY = "town.window.expanded";

/**
 * Whether the window is to be the Town's bigger one (toggled with its
 * button or Z). Only while the Town's world is on screen: main.tsx shrinks
 * the window everywhere else, and grows it again on the way back. Big
 * until the player picks small; their choice is remembered across launches.
 */
let expanded = (() => {
  if (!canExpandTown) return false;
  try {
    const v = localStorage.getItem(KEY);
    if (v !== null) return v === "1";
  } catch {
    // Default, then.
  }
  return true;
})();
const listeners = new Set<() => void>();

export function toggleTownExpanded(): void {
  if (!canExpandTown) return;
  expanded = !expanded;
  try {
    localStorage.setItem(KEY, expanded ? "1" : "0");
  } catch {
    // Not remembered, then.
  }
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
