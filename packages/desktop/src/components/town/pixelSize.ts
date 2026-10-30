import { useSyncExternalStore } from "react";

/**
 * How chunky the Town's pixels are: a debug slider in Settings (dev builds
 * only), remembered. Measured in screen pixels per Town pixel — whole ones,
 * so every pixel comes out the same size, as the map editor does it. Unset
 * (and always, outside dev builds), the Town uses PIXEL_SCALE.
 */
const KEY = "town.debug.pixelSize";

/** The Town's resolution as a fraction of the screen's: each drawn pixel
 * covers 1/PIXEL_SCALE screen pixels square (2.5: five device pixels on a
 * Retina screen, so the pixels all come out the same size). */
export const PIXEL_SCALE = 0.4;

/** At Home the camera's in close, so the herzie fills the window: its
 * pixels are drawn this many times bigger, to stay chunky. A whole number,
 * so a Town pixel still covers whole screen pixels. */
export const HOME_PIXEL_FACTOR = 2;

/** The default, as screen pixels per Town pixel (to the nearest). */
export function defaultPixelSize(): number {
  return Math.round(window.devicePixelRatio / PIXEL_SCALE);
}

export const PIXEL_SIZE_MIN = 1;
export const PIXEL_SIZE_MAX = 12;

let size: number | null = (() => {
  if (!import.meta.env.DEV) return null;
  try {
    const v = Number(localStorage.getItem(KEY));
    if (v >= PIXEL_SIZE_MIN && v <= PIXEL_SIZE_MAX) return Math.round(v);
  } catch {
    // Default, then.
  }
  return null;
})();

const listeners = new Set<() => void>();

/** Sets it (null: back to the default). */
export function setTownPixelSize(next: number | null): void {
  size = next;
  try {
    if (next === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(next));
  } catch {
    // Not remembered, then.
  }
  for (const l of listeners) l();
}

/** The chosen size, or null for the default. */
export function useTownPixelSize(): number | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => size,
  );
}
