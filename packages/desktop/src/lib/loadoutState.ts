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
