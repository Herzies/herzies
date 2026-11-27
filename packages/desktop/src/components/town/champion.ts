import type { ClassRole } from "@herzies/shared";
import { AWARD_ROLES } from "@herzies/shared/combat";
import { useSyncExternalStore } from "react";
import type { Look } from "../TownScene";

/** A herzie on the statue: the winner of one of a boss fight's awards. */
export type Champion = { look: Look; name: string };

/** Who the statue shows, an award each: Big Hitter, Soundproof,
 * Lifesaver. A role with nobody leaves its place empty. */
export type Champions = Partial<Record<ClassRole, Champion>>;

/** Until a ticket says who won, the statue shows these: eddie, top damage
 * on Nohoot Henry (2026-10-09), as Big Hitter (their look as the server has
 * it, seeded by friend code, less ground accessories, like a herzie out
 * walking), and a made-up Percussionist and Bard with their instruments. */
export const PLACEHOLDER_CHAMPIONS: Champions = {
  dps: {
    look: {
      seed: "HERZ-2CCV",
      stage: 3,
      equipped: {
        body: "gold-chain",
        head: "headphones",
        color: "purple-dane",
        scenery: "stars",
        modifier: ["first-edition", "good-eye-sniper"],
      },
    },
    name: "eddie",
  },
  tank: {
    look: {
      seed: "W-statue-tank",
      stage: 3,
      equipped: { main_hand: "worn-stick", off_hand: "old-cymbal" },
    },
    name: "rimshot",
  },
  support: {
    look: {
      seed: "W-statue-support",
      stage: 3,
      equipped: { main_hand: "lute" },
    },
    name: "hobgoblin",
  },
};

/** The champions as the server last told us: every Town ticket carries
 * each award's winner at the last boss fight that's over and had one. */
let current: Champions = PLACEHOLDER_CHAMPIONS;
let key = JSON.stringify(current);
const listeners = new Set<() => void>();

/** A ticket's champions. A role it has none for (null: nobody's won it
 * yet) keeps what's shown, as does a ticket without any (an older
 * server). Only a real change redraws the statue. */
export function setChampions(
  c: Partial<Record<ClassRole, Champion | null>> | null | undefined,
): void {
  if (!c) return;
  const next: Champions = { ...current };
  for (const role of AWARD_ROLES) {
    const champion = c[role];
    if (champion) next[role] = champion;
  }
  const nextKey = JSON.stringify(next);
  if (nextKey === key) return;
  current = next;
  key = nextKey;
  for (const l of listeners) l();
}

export function useChampions(): Champions {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
