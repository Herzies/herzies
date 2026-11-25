/**
 * Multispin's records (MULTISPIN in shared skills.ts): where they are as
 * their Record Slinger moves, and what they touch. Every judge (the boss's
 * cave, the Tower, duels, the Wilds) keeps one per spinning Slinger and
 * feeds it the bodies it may hit there. Pure.
 */
import { MULTISPIN, multispinOffset } from "@herzies/shared/skills";

/** A body a record may touch: the key its judge knows it by, where it
 * stands (as its caster saw it), and how wide it is. */
export type SpinBody = { key: string; x: number; z: number; r: number };

/** How often a record is looked at between two steps (ms): it moves less
 * than its own radius in that time (2π × MULTISPIN.radius a turn), so it
 * can't pass through a body between two looks. */
const LOOK_EVERY_MS = Math.max(
  1,
  Math.floor(
    (MULTISPIN.recordRadius * 0.6 * MULTISPIN.turnMs) /
      (2 * Math.PI * MULTISPIN.radius),
  ),
);

/** One Multispin: `records` records spinning from `from` until `until`,
 * round wherever their Slinger stands, as multispinOffset has them (the
 * app draws them from the same). */
export class Spin {
  private lastAt: number;
  /** When each record last touched each body (`record key`). */
  private touched = new Map<string, number>();

  constructor(
    readonly from: number,
    readonly until: number,
    readonly records: number,
  ) {
    this.lastAt = from;
  }

  /** Its time is up at `now`. */
  over(now: number): boolean {
    return now >= this.until;
  }

  /**
   * What its records touched since the last look, up to `now` (and no
   * later than its end): each record's touch of each of `bodies` (a record
   * on a body whose ground circle it overlaps, or sweeping past the bearing
   * of one whose centre is inside its ring, hugging the Slinger), never the
   * same record on the same body again within MULTISPIN.rehitMs. Swept:
   * looked at every LOOK_EVERY_MS between the two, round where `centreAt`
   * has its Slinger then. Call it every step, bodies or none, so it keeps
   * up.
   */
  touches(
    now: number,
    centreAt: (t: number) => { x: number; z: number } | null,
    bodies: readonly SpinBody[],
  ): { record: number; key: string; at: number }[] {
    const out: { record: number; key: string; at: number }[] = [];
    const end = Math.min(now, this.until);
    const start = this.lastAt;
    if (end <= start) return out;
    this.lastAt = end;
    if (!bodies.length) return out;
    const looks = Math.ceil((end - start) / LOOK_EVERY_MS);
    // How far round a record goes between two looks (radians).
    const sweep = (2 * Math.PI * (end - start)) / looks / MULTISPIN.turnMs;
    for (let s = 1; s <= looks; s++) {
      const t = start + ((end - start) * s) / looks;
      const c = centreAt(t);
      if (!c) continue;
      for (let i = 0; i < this.records; i++) {
        const o = multispinOffset(i, this.records, t - this.from);
        // Where it was at the last look, as an angle round the Slinger.
        const was = Math.atan2(o.z, o.x) - sweep;
        for (const b of bodies) {
          const dx = b.x - c.x;
          const dz = b.z - c.z;
          const over =
            Math.hypot(dx - o.x, dz - o.z) <= MULTISPIN.recordRadius + b.r;
          // Inside the ring: touched as the record's angle passes within
          // atan2(recordRadius + r, radius) of its bearing (the app's rule
          // too), swept from the last look to this one.
          const tol = Math.atan2(
            MULTISPIN.recordRadius + b.r,
            MULTISPIN.radius,
          );
          const passed =
            Math.hypot(dx, dz) < MULTISPIN.radius &&
            mod(Math.atan2(dz, dx) - (was - tol), 2 * Math.PI) <=
              sweep + 2 * tol;
          if (!over && !passed) continue;
          const k = `${i} ${b.key}`;
          const last = this.touched.get(k);
          if (last !== undefined && t < last + MULTISPIN.rehitMs) continue;
          this.touched.set(k, t);
          out.push({ record: i, key: b.key, at: t });
        }
      }
    }
    return out;
  }
}

/** `a` wrapped into [0, m). */
function mod(a: number, m: number): number {
  return ((a % m) + m) % m;
}
