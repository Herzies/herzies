import type { BossPlace } from "@herzies/shared";
import { useSyncExternalStore } from "react";

/** Fallen, the boss stands as stone this long (s), then crumbles into the
 * floor over this long (Boss.tsx); the end screen waits for both. */
export const STONE_HOLD = 1.2;
export const CRUMBLE = 1.1;

/** The end screen of the last boss fight you were in for the end of: how it
 * went and who dealt the most. Outlives the room (you're sent back to town
 * with it up) until you close it, or another fight starts. */
export type BossResults = {
  outcome: "victory" | "defeat";
  top: BossPlace[];
  you: BossPlace | null;
  /** When to show it (performance.now() ms): on a kill, once the boss has
   * crumbled away. */
  showAt: number;
};

let current: BossResults | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** The server's word that the fight is over. `fellAt` is when the boss fell
 * (performance.now() ms), if it did. */
export function setBossResults(
  r: Omit<BossResults, "showAt">,
  fellAt: number | null,
  now = performance.now(),
): void {
  const crumbled =
    fellAt === null ? now : fellAt + (STONE_HOLD + CRUMBLE) * 1000;
  current = { ...r, showAt: Math.max(now, crumbled) };
  emit();
}

export function clearBossResults(): void {
  if (!current) return;
  current = null;
  emit();
}

export function useBossResults(): BossResults | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
