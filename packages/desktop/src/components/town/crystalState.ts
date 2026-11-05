import type { CrystalState } from "@herzies/shared";
import { useSyncExternalStore } from "react";

// The Crystal as the app last heard it (sync, attune or upgrade), for the
// Town's HUD and payout screen. Fed from main.tsx; the 3D Crystal reads
// crystalLive, kept in step here so the canvas never re-renders for it.

/**
 * What the 3D Crystal shows, read every frame without re-rendering the
 * canvas: `charge` is fill / capacity (above 1 when overcharged), `burstAt`
 * when the last attune went off (performance.now() seconds) — the flash and
 * the ring run off it.
 */
export const crystalLive = {
  charge: 0,
  burstAt: -100,
};

/** Set the attune flash going. */
export function burstCrystal(): void {
  crystalLive.burstAt = performance.now() / 1000;
}

let current: CrystalState | null = null;

/** The map editor draws the Crystal whatever the server says, so it can be
 * placed and seen. */
export let crystalAlwaysShown = false;
export function showCrystalAlways(): void {
  crystalAlwaysShown = true;
}
const listeners = new Set<() => void>();

export function setCrystal(next: CrystalState | null | undefined): void {
  const value = next ?? null;
  if (
    value === current ||
    (value &&
      current &&
      value.fill === current.fill &&
      value.xp === current.xp &&
      value.dropsWaiting === current.dropsWaiting &&
      value.tier === current.tier &&
      value.attunes === current.attunes &&
      value.shards === current.shards &&
      value.enabled === current.enabled)
  )
    return;
  current = value;
  crystalLive.charge =
    value?.enabled && value.capacity > 0 ? value.fill / value.capacity : 0;
  for (const l of listeners) l();
}

export function getCrystal(): CrystalState | null {
  return current;
}

export function useCrystal(): CrystalState | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
