/**
 * What every fight holds a herzie (or a mob) to, whoever it's fighting: how
 * often it may cast, and how long a stun on it can last. The boss's cave,
 * the Tower and duels share these. Pure.
 */
import { stunMs } from "@herzies/shared/combat";
import { RIMSHOT } from "@herzies/shared/skills";

/** Cast tokens per herzie: one back every `everyMs` (sooner when it's
 * quicker), up to a short `burst`, so network jitter never costs a real
 * cast and a flood of them is refused. */
export class CastBudget {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly everyMs: number,
    private readonly burst: number,
  ) {}

  /** A cast's token from `uid`'s bucket at `now`, refilled at `quick` times
   * the base pace (Haste and Timing). False if it's empty: too fast. */
  spend(uid: string, now: number, quick: number): boolean {
    const bucket = this.buckets.get(uid) ?? { tokens: this.burst, at: now };
    bucket.tokens = Math.min(
      this.burst,
      bucket.tokens + (Math.max(0, now - bucket.at) / this.everyMs) * quick,
    );
    bucket.at = now;
    this.buckets.set(uid, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** `uid` starts over with a full bucket. */
  forget(uid: string): void {
    this.buckets.delete(uid);
  }
}

/** One target's recent stuns, for their diminishing returns (WoW-style):
 * each stun in the last {@link RIMSHOT.drWindowMs} halves the next. */
export class StunReturns {
  private recent: number[] = [];

  /** How long a stun of `base` landing at `now` lasts; it counts towards
   * the next one's. */
  take(now: number, base: number): number {
    this.recent = this.recent.filter((t) => t > now - RIMSHOT.drWindowMs);
    const ms = stunMs(base, this.recent.length);
    this.recent.push(now);
    return ms;
  }
}
