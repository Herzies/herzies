import { DUEL } from "@herzies/shared/duel";

/**
 * The duel HUD's numbers, kept pure so they're tested without a screen: the
 * clock and the countdown's beats.
 */

/** What the duel's clock shows at server time `now`: nothing until 30 s of
 * regulation are left, then those seconds; in sudden death, the time to
 * the hard end. */
export function duelClock(
  d: { startsAt: number; suddenAt: number; endsAt: number },
  now: number,
): { shown: boolean; sudden: boolean; ms: number } {
  if (now < d.startsAt) return { shown: false, sudden: false, ms: 0 };
  if (now >= d.suddenAt)
    return { shown: true, sudden: true, ms: Math.max(0, d.endsAt - now) };
  const left = d.suddenAt - now;
  return { shown: left <= DUEL_CLOCK_SHOWN_MS, sudden: false, ms: left };
}

/** The clock comes up with this much regulation left. */
export const DUEL_CLOCK_SHOWN_MS = 30_000;

/** "0:47". */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Which beat of the countdown it is at local time `now`, for a duel whose
 * countdown began at `at` and fights at `startsAt` (both local): the VS
 * card, 3, 2, 1, then the fight. */
export function countdownBeat(
  at: number,
  startsAt: number,
  intro: boolean,
  now: number,
): { beat: "vs" | 3 | 2 | 1 | "fight"; since: number } {
  if (now >= startsAt) return { beat: "fight", since: now - startsAt };
  const count = startsAt - 3 * DUEL.countMs;
  if (now < count)
    return { beat: intro ? "vs" : 3, since: now - (intro ? at : count) };
  const i = Math.min(2, Math.floor((now - count) / DUEL.countMs));
  return {
    beat: (3 - i) as 3 | 2 | 1,
    since: now - count - i * DUEL.countMs,
  };
}
