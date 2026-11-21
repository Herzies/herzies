import {
  type GameEvent,
  WILDS_EVENT_TYPE,
  type WildsService,
  wildsServiceOf,
} from "@herzies/shared";

/**
 * What the events feed says about the sky ship: the "wilds" event that's on
 * (as a timetable), and when the next one opens. EventsView hands both to
 * town/airship/service.ts, the way it opens the Tower's door.
 *
 * - `service`: the running event's window and interval; the latest started
 *   if two overlap. Null when none is on.
 * - `upcomingAt`: the next occurrence's start (ms since the epoch), for
 *   "Blåmann sails from…". Null when one is already on (the feed still lists
 *   the next one, which isn't news yet) or none is planned.
 */
export function wildsFeed(
  live: readonly GameEvent[],
  upcoming: readonly GameEvent[],
): { service: WildsService | null; upcomingAt: number | null } {
  let service: WildsService | null = null;
  for (const e of live) {
    if (e.type !== WILDS_EVENT_TYPE) continue;
    const startsAt = Date.parse(e.startsAt);
    const endsAt = Date.parse(e.endsAt);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) continue;
    if (service && service.startsAt >= startsAt) continue;
    service = wildsServiceOf(startsAt, endsAt, e.config);
  }
  if (service) return { service, upcomingAt: null };
  const next = upcoming.find((e) => e.type === WILDS_EVENT_TYPE);
  const at = next ? Date.parse(next.startsAt) : Number.NaN;
  return { service: null, upcomingAt: Number.isFinite(at) ? at : null };
}
