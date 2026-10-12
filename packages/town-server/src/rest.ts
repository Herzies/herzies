/**
 * Bench rest: seconds a herzie spent sitting, so the room can ask for the
 * extra health that resting earns on top of the base regen (see
 * `benchBonusHp`). Pure, so it's tested without a room.
 */

/** Longest stretch one tick may credit: after a hibernation the room has no
 * idea how long it was out, and shouldn't hand out the gap. */
export const MAX_REST_GAP_MS = 60_000;

export class RestMeter {
  private since: number | null = null;
  private seconds = 0;

  /** Note whether the herzie is sitting as of `now`: credits the time since
   * the last call if it was sitting then. */
  tick(seated: boolean, now: number): void {
    if (this.since !== null) {
      this.seconds +=
        Math.min(Math.max(0, now - this.since), MAX_REST_GAP_MS) / 1000;
    }
    this.since = seated ? now : null;
  }

  /** The seated seconds credited since the last take. */
  take(): number {
    const s = this.seconds;
    this.seconds = 0;
    return s;
  }
}
