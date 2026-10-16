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

/**
 * A made-up end screen, to look at without a fight: the top three one of
 * each class with their gear, and you at `rank` (past 3 shows under the
 * "…"; 0 for no place). For the town sandbox's `?results=` and Settings >
 * Debug.
 */
export function sampleBossResults(
  outcome: BossResults["outcome"],
  rank = 7,
): Omit<BossResults, "showAt"> {
  const looks = [
    {
      seed: "HERZ-2CCV",
      stage: 3,
      equipped: { main_hand: "compact-discs", head: "headphones" },
    },
    { seed: "HERZ-HOBG", stage: 2, equipped: { main_hand: "lute" } },
    {
      seed: "HERZ-RIMS",
      stage: 3,
      equipped: { main_hand: "worn-stick", off_hand: "old-cymbal" },
    },
  ];
  const names = ["eddie", "hobgoblin", "rimshot", "Mathias", "lutey"];
  const table: BossPlace[] = names.map((name, i) => ({
    rank: i + 1,
    name,
    damage: Math.round(48_000 / (i + 1.4)),
    heal: i === 1 ? 1_240 : i === 2 ? 310 : 0,
    look: looks[i],
  }));
  const you =
    rank > 0
      ? (table[rank - 1] ?? { rank, name: "you", damage: 812, heal: 96 })
      : null;
  return { outcome, top: table.slice(0, 3), you };
}

let lastSample: BossResults["outcome"] = "defeat";

/** Dev only (Settings > Debug > "Test End Screen"): the made-up end screen,
 * victory and defeat in turn. It shows in the Town. */
export function debugBossResults(): void {
  lastSample = lastSample === "victory" ? "defeat" : "victory";
  setBossResults(sampleBossResults(lastSample), null);
}
