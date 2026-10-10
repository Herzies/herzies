/**
 * Where each player was over the last second, so the room can ask where
 * someone stood a moment ago. An attack that lands is judged against the
 * past as well as the present, which favours the player who dodged on a
 * laggy connection. Pure.
 */

type Sample = { t: number; x: number; z: number };

/** How far back it remembers, ms. */
export const HISTORY_MS = 1_000;

export class PositionHistory {
  private byUid = new Map<string, Sample[]>();

  record(uid: string, t: number, x: number, z: number): void {
    let samples = this.byUid.get(uid);
    if (!samples) {
      samples = [];
      this.byUid.set(uid, samples);
    }
    const last = samples[samples.length - 1];
    if (last && t < last.t) return; // out of order
    if (last && last.t === t) {
      last.x = x;
      last.z = z;
    } else {
      samples.push({ t, x, z });
    }
    const cutoff = t - HISTORY_MS;
    let drop = 0;
    // Keep one sample at or before the cutoff so `at` can interpolate to it.
    while (drop + 1 < samples.length && samples[drop + 1].t <= cutoff) drop++;
    if (drop) samples.splice(0, drop);
  }

  /** Where `uid` was at `t`: interpolated between samples, held at the
   * newest after the last one and at the oldest before the first. Null if
   * never seen. */
  at(uid: string, t: number): { x: number; z: number } | null {
    const samples = this.byUid.get(uid);
    if (!samples?.length) return null;
    if (t <= samples[0].t) return { x: samples[0].x, z: samples[0].z };
    const last = samples[samples.length - 1];
    if (t >= last.t) return { x: last.x, z: last.z };
    for (let i = samples.length - 1; i > 0; i--) {
      const a = samples[i - 1];
      const b = samples[i];
      if (t >= a.t) {
        const k = (t - a.t) / (b.t - a.t || 1);
        return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
      }
    }
    return { x: last.x, z: last.z };
  }

  forget(uid: string): void {
    this.byUid.delete(uid);
  }
}
