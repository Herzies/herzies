import { useSyncExternalStore } from "react";

/**
 * Whether the Town shows its frame rate. A debug switch in Settings,
 * remembered; on to begin with in dev builds, off otherwise.
 */
const KEY = "town.fps.shown";

let shown = (() => {
  try {
    const v = localStorage.getItem(KEY);
    if (v !== null) return v === "1";
  } catch {
    // Default, then.
  }
  return import.meta.env.DEV;
})();

const listeners = new Set<() => void>();

export function setFpsShown(on: boolean): void {
  shown = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // Not remembered, then.
  }
  for (const l of listeners) l();
}

export function useFpsShown(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => shown,
  );
}
