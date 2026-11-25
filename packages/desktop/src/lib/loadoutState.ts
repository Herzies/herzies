import type { LoadoutState } from "@herzies/shared";
import { useSyncExternalStore } from "react";

// The loadouts as the app last heard them (a sync, an item response, a
// switch), for whatever needs them away from main.tsx: the Deck's tabs, and
// the warnings where a copy the other loadout uses could leave the bank (a
// sell, a listing, a trade, a risky roll). Fed from main.tsx.

let current: LoadoutState | null = null;
const listeners = new Set<() => void>();

export function setLoadouts(next: LoadoutState | null | undefined): void {
  const value = next ?? null;
  if (value === current) return;
  current = value;
  for (const l of listeners) l();
}

export function useLoadouts(): LoadoutState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** Least time between two loadout switches, however they're asked for (the
 * Deck's tabs or a hotbar key): long enough that swapping gear can't be done
 * mid-scrap, over the server's own gap (LOADOUT_SWITCH_GAP_MS). */
export const LOADOUT_COOLDOWN_MS = 5_000;

/** When the last switch went out (`performance.now()`). */
let switchedAt = Number.NEGATIVE_INFINITY;

export function markLoadoutSwitched(now = performance.now()): void {
  switchedAt = now;
  tickCooldown();
}

/** Milliseconds until loadouts may switch again: 0 when they may. */
export function loadoutCooldownLeft(now = performance.now()): number {
  return Math.max(0, switchedAt + LOADOUT_COOLDOWN_MS - now);
}

/** Whole seconds left of the cooldown, kept by a timer that ticks only
 * while it runs. */
let cooldownSecs = 0;
let ticker: ReturnType<typeof setTimeout> | undefined;
const cooldownListeners = new Set<() => void>();
function tickCooldown() {
  clearTimeout(ticker);
  const left = loadoutCooldownLeft();
  const secs = Math.ceil(left / 1000);
  if (secs !== cooldownSecs) {
    cooldownSecs = secs;
    for (const l of cooldownListeners) l();
  }
  // Next when the count drops a second.
  if (left > 0) ticker = setTimeout(tickCooldown, left - (secs - 1) * 1000);
}

/** Seconds until loadouts may switch again (0 when they may), for what
 * shows it in words. */
export function useLoadoutCooldownSecs(): number {
  return useSyncExternalStore(
    (l) => {
      cooldownListeners.add(l);
      return () => cooldownListeners.delete(l);
    },
    () => cooldownSecs,
  );
}
