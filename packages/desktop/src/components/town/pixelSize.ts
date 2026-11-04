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
 * pixels are drawn this many times bigger, to stay chunky (rounded to whole
 * screen pixels by homeDpr, so they all come out the same size). */
export const HOME_PIXEL_FACTOR = 1.4;

/** The canvas resolution at Home, given the Town's (`dpr`): each pixel
 * HOME_PIXEL_FACTOR times bigger, to the nearest whole screen pixel. */
export function homeDpr(dpr: number): number {
  const device = window.devicePixelRatio;
  const pixel = Math.max(1, Math.round((device / dpr) * HOME_PIXEL_FACTOR));
  return device / pixel;
}

/** The canvas resolution for a fraction of the screen's (`scale`), nudged
 * so each drawn pixel covers a whole number of device pixels: 0.4 on a
 * plain (1×) screen would be 2.5 device pixels a pixel, alternately 2 and 3
 * wide, and things wobble as they move across them. */
export function wholePixelDpr(scale: number = PIXEL_SCALE): number {
  const device = window.devicePixelRatio;
  return device / Math.max(1, Math.round(device / scale));
}

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

/** Drawn this many times the resolution each way when supersampling. */
export const SUPERSAMPLE = 2;

/**
 * Supersampling (Settings > Graphics, off by default): each big pixel the
 * average of what it covers — drawn at SUPERSAMPLE times the resolution and
 * each block averaged down (see vfx/blockAverage.ts) — rather than one
 * point of it, so thin and distant things stop flickering as the camera
 * moves. About four times the drawing. In dev builds `?supersample=1` on
 * the page turns it on. (The website's showcase always supersamples.)
 */
const SUPERSAMPLE_KEY = "town.graphics.supersample";

let supersample: boolean = (() => {
  try {
    if (
      import.meta.env.DEV &&
      new URLSearchParams(location.search).get("supersample") === "1"
    )
      return true;
    return localStorage.getItem(SUPERSAMPLE_KEY) === "1";
  } catch {
    return false;
  }
})();

const supersampleListeners = new Set<() => void>();

export function setTownSupersample(on: boolean): void {
  supersample = on;
  try {
    if (on) localStorage.setItem(SUPERSAMPLE_KEY, "1");
    else localStorage.removeItem(SUPERSAMPLE_KEY);
  } catch {
    // Not remembered, then.
  }
  for (const l of supersampleListeners) l();
}

export function useTownSupersample(): boolean {
  return useSyncExternalStore(
    (cb) => {
      supersampleListeners.add(cb);
      return () => supersampleListeners.delete(cb);
    },
    () => supersample,
  );
}
