/**
 * Forbidden Frequency's bleeds (FORBIDDEN_FREQUENCY in shared skills.ts):
 * its discs in flight, the one bleed each target holds, and when it hits.
 * Every judge (the boss's cave, the Tower, duels, the Wilds) keeps one,
 * keyed by whatever it calls its targets and lasting as long as a bleed
 * lasts there, and works out each bleed hit itself (who may be hit, its
 * share of a wave, Def, domes). Pure.
 */
import type { HitStats } from "@herzies/shared/combat";
import { bleedEveryMs, FORBIDDEN_FREQUENCY } from "@herzies/shared/skills";

/** A Forbidden Frequency disc on its way: from `by` (at its skill `level`,
 * rolling its hits with `stats`), to `key`, landing `at`. */
export type BleedDisc = {
  at: number;
  by: string;
  key: string;
  level: number;
  stats: HitStats;
};

/** A target's bleed: its newest thrower (credited, its stats rolling the
 * hits), the strongest thrower's level, its stacks, until when it runs,
 * and its next hit. */
export type Bleed = {
  by: string;
  level: number;
  stats: HitStats;
  stacks: number;
  until: number;
  nextAt: number;
};

export class Bleeds {
  private discs: BleedDisc[] = [];
  private bleeds = new Map<string, Bleed>();

  /** `lastsMs`: how long a bleed runs from its newest stack (SKILL_DEFS'
   * durationMs on mobs and the boss, FORBIDDEN_FREQUENCY.herzieMs on
   * herzies). */
  constructor(private readonly lastsMs: number) {}

  /** Discs in flight, or a bleed running: something to keep ticking for. */
  get busy(): boolean {
    return this.discs.length > 0 || this.bleeds.size > 0;
  }

  /** A disc thrown (see BleedDisc). */
  throw(disc: BleedDisc): void {
    this.discs.push(disc);
  }

  /** The discs that have landed by `now`, oldest first: the judge says
   * whether each takes hold (`stack`), or is lost (its target gone, a
   * dome). */
  landed(now: number): BleedDisc[] {
    const due = this.discs
      .filter((d) => d.at <= now)
      .sort((a, b) => a.at - b.at);
    if (due.length) this.discs = this.discs.filter((d) => d.at > now);
    return due;
  }

  /** `disc` took hold at `now`: its target's bleed gains a stack (up to
   * FORBIDDEN_FREQUENCY.maxStacks) and starts its time over, credited to
   * this thrower at the stronger of the two levels. More stacks hit more
   * often (bleedEveryMs): the next hit comes no later than the quicker
   * beat from now. */
  stack(disc: BleedDisc, now: number): Bleed {
    const until = now + this.lastsMs;
    const b = this.bleeds.get(disc.key);
    if (!b) {
      const fresh: Bleed = {
        by: disc.by,
        level: disc.level,
        stats: disc.stats,
        stacks: 1,
        until,
        nextAt: now + bleedEveryMs(1),
      };
      this.bleeds.set(disc.key, fresh);
      return fresh;
    }
    b.stacks = Math.min(FORBIDDEN_FREQUENCY.maxStacks, b.stacks + 1);
    b.until = until;
    b.by = disc.by;
    b.stats = disc.stats;
    b.level = Math.max(b.level, disc.level);
    b.nextAt = Math.min(b.nextAt, now + bleedEveryMs(b.stacks));
    return b;
  }

  /** Bleed hits due by `now` (each its target, its bleed, and when), one
   * every bleedEveryMs(stacks), and bleeds whose time is up gone. */
  ticks(now: number): { key: string; bleed: Bleed; at: number }[] {
    const out: { key: string; bleed: Bleed; at: number }[] = [];
    for (const [key, b] of this.bleeds) {
      while (b.nextAt <= now && b.nextAt <= b.until) {
        out.push({ key, bleed: b, at: b.nextAt });
        b.nextAt += bleedEveryMs(b.stacks);
      }
      if (now >= b.until) this.bleeds.delete(key);
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** `key` fell or went: its bleed ends, and discs on their way to it are
   * lost. Its bleed, if it had one. */
  end(key: string): Bleed | undefined {
    this.discs = this.discs.filter((d) => d.key !== key);
    const b = this.bleeds.get(key);
    this.bleeds.delete(key);
    return b;
  }

  /** Every target with a bleed running. */
  keys(): string[] {
    return [...this.bleeds.keys()];
  }

  /** `by` went: its discs are lost, and bleeds it threw last end (nobody
   * to credit their ticks to). The targets that lost one. */
  forget(by: string): string[] {
    this.discs = this.discs.filter((d) => d.by !== by);
    const lost: string[] = [];
    for (const [key, b] of this.bleeds)
      if (b.by === by) {
        this.bleeds.delete(key);
        lost.push(key);
      }
    return lost;
  }

  /** Everything ends (a floor left behind). */
  clear(): void {
    this.discs = [];
    this.bleeds.clear();
  }
}
