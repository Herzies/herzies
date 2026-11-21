import { WILDS_LEG_MS, type WildsService } from "@herzies/shared";
import { useSyncExternalStore } from "react";

/**
 * The sky ship's service, as the events feed says (see EventsView): the
 * "wilds" event that's on, if any, and when the next one opens. A tiny
 * store outside React, read every frame by the ship and re-rendering the
 * few things that show it.
 */

let current: WildsService | null = null;
let upcoming: number | null = null;
/** The events feed has said, at least once (till then, "no service" is
 * only not knowing yet). */
let known = false;
const listeners = new Set<() => void>();

/** How long after a service ends the ship is still running: its last run
 * left home before the end, so it's back within half an interval and a
 * leg of it. */
function tailEnd(s: WildsService): number {
  return s.endsAt + s.departEveryMs / 2 + WILDS_LEG_MS;
}

const same = (a: WildsService | null, b: WildsService | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.startsAt === b.startsAt &&
    a.endsAt === b.endsAt &&
    a.departEveryMs === b.departEveryMs);

/** The service that's on (null: none). One that's just ended is kept
 * until the ship's home from its last run, though the feed no longer
 * lists it. */
export function setWildsService(
  next: WildsService | null,
  now = Date.now(),
): void {
  known = true;
  const keep = !next && current !== null && now < tailEnd(current);
  const value = keep ? current : next;
  if (same(value, current)) return;
  current = value;
  for (const l of listeners) l();
}

/** When the next service opens, ms since the epoch (null: none planned). */
export function setWildsUpcoming(startsAt: number | null): void {
  if (startsAt === upcoming) return;
  upcoming = startsAt;
  for (const l of listeners) l();
}

/** The service the ship is running on (null: none; it's laid up). */
export function wildsService(): WildsService | null {
  return current;
}

/** Whether the events feed has said what's on yet. */
export function wildsServiceKnown(): boolean {
  return known;
}

/** When the next service opens (null: none planned, or one's on). */
export function wildsUpcoming(): number | null {
  return upcoming;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** {@link wildsService}, re-rendering when it changes. */
export function useWildsService(): WildsService | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** {@link wildsUpcoming}, re-rendering when it changes. */
export function useWildsUpcoming(): number | null {
  return useSyncExternalStore(subscribe, () => upcoming);
}
