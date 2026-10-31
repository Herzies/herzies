import { BOBOKU_KEY, MEDEA_KEY, TOWER_GUARD_KEY } from "@herzies/shared";
import { useSyncExternalStore } from "react";
import type { EventCard } from "../TownScene";

// Who the player has talked to: a visitor nobody's talked to yet wears a "!"
// over their head until they do. Each visit is its own arrival (George back
// next week is new again). The residents live here, so they never wear one. Kept in
// localStorage, per device: a "!" coming back on a new machine is harmless.

const STORAGE_KEY = "herzies.town.met";

/** Who lives in Town rather than visiting: they never arrive, so never wear
 * a "!". Plutus (MARKET_KEY) lives there too but isn't listed: he's new, so
 * he wears the newcomer's "!" once, and after that only his own (something
 * to collect, card.notice). */
export const RESIDENTS: ReadonlySet<string> = new Set([
  BOBOKU_KEY,
  MEDEA_KEY,
  TOWER_GUARD_KEY,
]);
/** Enough for every visit in a long while; the oldest are forgotten. */
const MAX_KEPT = 200;

const listeners = new Set<() => void>();

function load(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((k) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

let met = new Set(load());

/** The arrival a card stands for: this visit of theirs. */
export const arrivalKey = (card: EventCard) =>
  card.eventId ? `${card.type}:${card.eventId}` : card.type;

/** The player has talked to them: their "!" goes. */
export function markMet(card: EventCard): void {
  const key = arrivalKey(card);
  if (met.has(key)) return;
  met = new Set([...met, key].slice(-MAX_KEPT));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...met]));
  } catch {
    // Private mode or full: the "!" just comes back next launch.
  }
  for (const l of listeners) l();
}

/** Whether the player has talked to them yet, re-rendering when they do. */
export function useMet(card: EventCard): boolean {
  const key = arrivalKey(card);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => met.has(key),
  );
}
