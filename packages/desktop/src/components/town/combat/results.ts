import type {
  AwardBoard,
  AwardMine,
  AwardPlace,
  TownLook,
} from "@herzies/shared";
import { useSyncExternalStore } from "react";

/** Fallen, the boss stands as stone this long (s), then crumbles into the
 * floor over this long (Boss.tsx). */
export const STONE_HOLD = 1.2;
export const CRUMBLE = 1.1;
/** The end screen comes up this long after the boss falls (ms): the
 * killing blow lands, then the results, then the loot. */
const SHOW_AFTER_FALL_MS = 600;

/** The end screen of the last boss fight you were in for the end of: how it
 * went, its three awards (in AWARD_ROLES order), and your own result
 * (null if you did nothing). Outlives the room (you're sent back to town
 * with it up) until you close it, or another fight starts. */
export type BossResults = {
  outcome: "victory" | "defeat";
  awards: AwardBoard[];
  mine: AwardMine | null;
  /** When to show it (performance.now() ms): on a kill, just after. */
  showAt: number;
};

/** Set by the server; shown from `showAt` until closed. */
let current: BossResults | null = null;
let shown: BossResults | null = null;
let showTimer: ReturnType<typeof setTimeout> | undefined;
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
  const after = fellAt === null ? now : fellAt + SHOW_AFTER_FALL_MS;
  const r2 = { ...r, showAt: Math.max(now, after) };
  current = r2;
  shown = null;
  clearTimeout(showTimer);
  const wait = r2.showAt - now;
  if (wait <= 0) shown = r2;
  else
    showTimer = setTimeout(() => {
      if (current !== r2) return;
      shown = r2;
      emit();
    }, wait);
  emit();
}

export function clearBossResults(): void {
  if (!current) return;
  current = null;
  shown = null;
  clearTimeout(showTimer);
  emit();
}

/** The end screen, from the moment it's up until it's closed; null
 * otherwise. The Town's HUD and the chat step aside while it's up. */
export function useBossResultsShown(): BossResults | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => shown,
  );
}

/**
 * A made-up end screen, to look at without a fight: a Big Hitter, a
 * Soundproof and a Lifesaver with their gear, and you a Bard at `rank` for
 * Lifesaver (1 wins it; past 3 shows under the best three in Details; 0
 * for no result). For the town sandbox's `?results=` and Settings > Debug.
 */
export function sampleBossResults(
  outcome: BossResults["outcome"],
  rank = 4,
): Omit<BossResults, "showAt"> {
  const looks: Record<string, TownLook> = {
    eddie: {
      seed: "HERZ-2CCV",
      stage: 3,
      equipped: { main_hand: "compact-discs", head: "headphones" },
    },
    rimshot: {
      seed: "HERZ-RIMS",
      stage: 3,
      equipped: { main_hand: "worn-stick", off_hand: "old-cymbal" },
    },
    hobgoblin: { seed: "HERZ-HOBG", stage: 2, equipped: { main_hand: "lute" } },
    Mathias: { seed: "HERZ-MATH", stage: 3, equipped: { main_hand: "lute" } },
  };
  const place = (
    rank: number,
    name: string,
    share: number,
    stats: Partial<Omit<AwardPlace, "rank" | "name" | "share">>,
  ): AwardPlace => ({
    rank,
    name,
    share,
    damage: 0,
    healed: 0,
    blocked: 0,
    tanked: 0,
    ...stats,
  });
  const hitters = [
    place(1, "eddie", 0.31, { damage: 330_000 }),
    place(2, "Vinyl Vex", 0.27, { damage: 290_000 }),
    place(3, "Lo-Fi Lou", 0.22, { damage: 236_000 }),
  ];
  const tanks = [
    place(1, "rimshot", 0.84, { damage: 157_000, tanked: 255, blocked: 4_100 }),
    place(2, "Snare", 0.16, { damage: 121_000, tanked: 20, blocked: 800 }),
  ];
  // The healers, best first, you among them at `rank`.
  const heals = [13_800, 9_500, 5_200, 3_100, 2_400, 1_600, 900, 400, 150];
  const at = Math.min(Math.max(0, Math.floor(rank)), heals.length);
  const names = [
    "hobgoblin",
    "Lullaby",
    "Mossy",
    "Hymn",
    "Wren",
    "Carol",
    "Psalm",
    "Coda",
  ];
  if (at) names.splice(at - 1, 0, "Mathias");
  const total = names.reduce((n, _, i) => n + heals[i], 0);
  const healers = names.map((name, i) =>
    place(i + 1, name, heals[i] / total, {
      damage: 74_000 - i * 6_000,
      healed: heals[i],
    }),
  );
  const winner = (p: AwardPlace) => ({ ...p, look: looks[p.name] });
  return {
    outcome,
    awards: [
      { role: "dps", winner: winner(hitters[0]), top: hitters },
      { role: "tank", winner: winner(tanks[0]), top: tanks },
      { role: "support", winner: winner(healers[0]), top: healers.slice(0, 3) },
    ],
    mine: at
      ? { role: "support", place: healers[at - 1], won: at === 1 }
      : null,
  };
}

let lastSample: BossResults["outcome"] = "defeat";

/** Dev only (Settings > Debug > "Test End Screen"): the made-up end screen,
 * victory and defeat in turn. It shows in the Town. */
export function debugBossResults(): void {
  lastSample = lastSample === "victory" ? "defeat" : "victory";
  setBossResults(sampleBossResults(lastSample), null);
}
