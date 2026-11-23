/**
 * The time the sky ship keeps: the town server's wall clock, as best we
 * can tell, kept smooth.
 *
 * The ship's timetable is in server time (the event's window comes from
 * the database), and every client draws the ship from it. The machine's own
 * clock is usually within a few tens of milliseconds of that, so it's
 * where we start; snapshots from the room (stamped with the server's time)
 * then tell us how far off it is. Unlike the connection's own clock, which
 * resets with every room and jumps whenever a quicker packet arrives, this
 * one outlives rooms and only ever slews — at most 5% faster or slower than
 * real time — so a correction never moves a ship (or anyone on its deck)
 * with a jolt. Only a gross error (a machine clock seconds out) is put
 * right in one go, and that only before we've heard from a server.
 */

/** Slew rate: how much faster or slower than real time it may run. */
const SLEW = 0.05;
/** Further out than this, the first estimate is taken at once. */
const SNAP_MS = 1500;
/** The best (least delayed) sample ages out this fast, ms per second, so a
 * route that got slower is followed. */
const CREEP_MS_PER_S = 2;

/** Server minus local, as the least-delayed packet says (null: none yet). */
let estimate: number | null = null;
let estimatedAt = 0;
/** What's in use: eased toward the estimate. */
let offset = 0;
let lastLocal: number | null = null;
let heard = false;

/** A packet stamped `serverMs` arrived at local wall time `localMs`. */
export function noteServerTime(serverMs: number, localMs = Date.now()): void {
  // It was sent a little before it arrived: server − local is at least
  // this; the packet that took least time says the most.
  const sample = serverMs - localMs;
  if (estimate === null) {
    estimate = sample;
  } else {
    const aged = estimate - (CREEP_MS_PER_S * (localMs - estimatedAt)) / 1000;
    estimate = Math.max(sample, aged);
  }
  estimatedAt = localMs;
  if (!heard) {
    heard = true;
    if (Math.abs(estimate - offset) > SNAP_MS) offset = estimate;
  }
}

/** The server's time now, ms since the epoch. */
export function skyNow(localMs = Date.now()): number {
  const dt = lastLocal === null ? 0 : Math.max(0, localMs - lastLocal);
  lastLocal = localMs;
  if (estimate !== null) {
    const step = SLEW * dt;
    offset += Math.max(-step, Math.min(step, estimate - offset));
  }
  return localMs + offset;
}

/** Forget everything (tests). */
export function resetSkyClock(): void {
  estimate = null;
  estimatedAt = 0;
  offset = 0;
  lastLocal = null;
  heard = false;
}
