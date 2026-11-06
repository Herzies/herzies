/**
 * A Record Slinger's two discs, as the server holds it to them: a hand
 * throws only once its disc is back (shared discCycleMs), so the pace the
 * app keeps at range is the pace the server allows. The app's discs are
 * out a little longer than this (they're caught where the hand is), so
 * the server is lenient: a share off the cycle and a fixed slack, never
 * stricter than an honest client.
 */
import { discCycleMs } from "@herzies/shared/combat";

/** How much of a disc's time out the server insists on, and how much
 * sooner still it lets a throw through (network jitter). */
export const HAND_LENIENCY = 0.85;
export const HAND_SLACK_MS = 60;

export class DiscHands {
  private hands = new Map<string, [number, number]>();

  /**
   * A throw from `uid` at `now` whose disc hits at `hitDist` (null: it
   * hits nothing), at attack speed `quick`. True, and the hand is out
   * until its disc is back; false if both are still out.
   */
  take(
    uid: string,
    now: number,
    hitDist: number | null,
    quick: number,
  ): boolean {
    const h = this.hands.get(uid) ?? [0, 0];
    const i = h[0] <= h[1] ? 0 : 1;
    if (h[i] > now + HAND_SLACK_MS) return false;
    // A throw the server sees hit nothing may have met what it can't see
    // (a wall, the floor, a mob drawn a moment off) and be back at once:
    // only a hit it judged holds the hand for its flight.
    h[i] =
      now + discCycleMs(hitDist === null ? 0 : hitDist, quick) * HAND_LENIENCY;
    this.hands.set(uid, h);
    return true;
  }

  forget(uid: string): void {
    this.hands.delete(uid);
  }
}
