import { useSyncExternalStore } from "react";
import type { Look } from "../TownScene";

/** Who a statue shows: whoever came out on top in the last boss fight. */
export type Champion = { look: Look; name: string };

/** Until a ticket says who won, the statue shows eddie, top damage on
 * Nohoot Henry (2026-10-09). Their look as the server has it (seeded by
 * friend code), less ground accessories, like a herzie out walking. */
export const PLACEHOLDER_CHAMPION: Champion = {
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
};

/** The champion as the server last told us: every Town ticket carries the
 * top damage dealer of the last boss fight that's over. */
let current: Champion = PLACEHOLDER_CHAMPION;
let key = JSON.stringify(current);
const listeners = new Set<() => void>();

/** A ticket's champion (null: none yet, keep what's shown). Only a real
 * change redraws the statue. */
export function setChampion(c: Champion | null | undefined): void {
  if (!c) return;
  const next = JSON.stringify(c);
  if (next === key) return;
  current = c;
  key = next;
  for (const l of listeners) l();
}

export function useChampion(): Champion {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
