/**
 * Smooth motion for other players in the multiplayer Town.
 *
 * Remote herzies are drawn a little in the past, between two states the
 * server has already sent, instead of guessing ahead: "snapshot
 * interpolation", as in Source and most action games. The delay is kept as
 * small as the connection allows — about two server ticks on a steady link,
 * more when packets arrive unevenly.
 *
 * Pure and clock-agnostic (times are passed in) so it can be unit-tested.
 */
import { TOWN_TICK_MS, type TownState } from "./town-net.js";

/** Shortest delay drawn behind the server: a tick and a half. */
const MIN_DELAY_MS = TOWN_TICK_MS * 1.5;
const MAX_DELAY_MS = 350;
/** How fast the delay follows the measured jitter, per second. */
const DELAY_EASE = 2;
/** The clock offset estimate may creep this much a second, so a route that
 * gets slower is followed rather than read as everyone standing still. */
const OFFSET_DRIFT_MS_PER_S = 2;
/** Past the newest state, keep a herzie walking this long before it stops. */
export const EXTRAPOLATE_MS = 250;
/** A step this long between two states is a teleport, drawn as a jump. */
export const TELEPORT_DISTANCE = 5;
/** States kept behind the drawing time. */
const KEEP_MS = 1000;

/**
 * Maps local time onto the server's clock, and picks how far in the past to
 * draw. One per connection, shared by every remote herzie.
 */
export class ServerClock {
  /** Smallest seen (local − server): the least-delayed packet's offset. */
  private offset: number | null = null;
  private lastLocal = 0;
  /** Average extra delay over the best packet, ms. */
  private jitter = 0;
  /** Current drawing delay, eased toward its target. */
  delay = MIN_DELAY_MS * 1.5;

  /** Feeds a packet stamped `serverTime` that arrived at `localNow`. */
  observe(serverTime: number, localNow: number): void {
    const sample = localNow - serverTime;
    if (this.offset === null) {
      this.offset = sample;
      this.lastLocal = localNow;
      return;
    }
    const dt = Math.max(0, (localNow - this.lastLocal) / 1000);
    this.lastLocal = localNow;
    this.offset = Math.min(sample, this.offset + OFFSET_DRIFT_MS_PER_S * dt);
    const extra = sample - this.offset;
    this.jitter += (extra - this.jitter) * 0.1;
    const target = Math.min(
      MAX_DELAY_MS,
      Math.max(MIN_DELAY_MS, TOWN_TICK_MS + this.jitter * 2.5),
    );
    this.delay += (target - this.delay) * Math.min(1, DELAY_EASE * dt);
  }

  get synced(): boolean {
    return this.offset !== null;
  }

  /** The server time to draw remote herzies at. */
  renderTime(localNow: number): number {
    return localNow - (this.offset ?? 0) - this.delay;
  }

  reset(): void {
    this.offset = null;
    this.jitter = 0;
    this.delay = MIN_DELAY_MS * 1.5;
  }
}

type Sample = { t: number; s: TownState };

function angleDelta(from: number, to: number): number {
  const d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) return d - Math.PI * 2;
  if (d <= -Math.PI) return d + Math.PI * 2;
  return d;
}

/** One remote herzie's recent states, in server time. */
export class EntityBuffer {
  private samples: Sample[] = [];

  push(t: number, s: TownState): void {
    const last = this.samples[this.samples.length - 1];
    if (last && t <= last.t) return;
    // After a quiet spell (standing still sends nothing), pin the old spot
    // just before the new state, or the herzie would slide there slowly
    // across the whole gap.
    if (last && t - last.t > TOWN_TICK_MS * 2.5) {
      this.samples.push({ t: t - TOWN_TICK_MS, s: { ...last.s, speed: 0 } });
    }
    this.samples.push({ t, s });
  }

  get empty(): boolean {
    return this.samples.length === 0;
  }

  /** Where to draw the herzie at server time `t`. */
  sample(t: number): TownState | null {
    const n = this.samples.length;
    if (n === 0) return null;
    // Drop states nobody will draw again, keeping the one just before `t`.
    let drop = 0;
    while (
      drop < n - 2 &&
      this.samples[drop + 1].t <= t &&
      this.samples[drop + 1].t < t - KEEP_MS
    )
      drop++;
    if (drop) this.samples.splice(0, drop);

    const first = this.samples[0];
    if (t <= first.t) return first.s;
    for (let i = 1; i < this.samples.length; i++) {
      const b = this.samples[i];
      if (t >= b.t) continue;
      const a = this.samples[i - 1];
      if (Math.hypot(b.s.x - a.s.x, b.s.z - a.s.z) > TELEPORT_DISTANCE)
        return a.s;
      const k = (t - a.t) / (b.t - a.t);
      return {
        x: a.s.x + (b.s.x - a.s.x) * k,
        z: a.s.z + (b.s.z - a.s.z) * k,
        heading: a.s.heading + angleDelta(a.s.heading, b.s.heading) * k,
        speed: a.s.speed + (b.s.speed - a.s.speed) * k,
        flags: a.s.flags,
      };
    }
    // Past the newest state: a herzie that was walking keeps going a moment
    // along its last movement (covers a late packet), then stops there.
    const last = this.samples[this.samples.length - 1];
    const prev = this.samples[this.samples.length - 2];
    if (!prev || last.s.speed === 0) return last.s;
    const span = last.t - prev.t;
    const dx = last.s.x - prev.s.x;
    const dz = last.s.z - prev.s.z;
    if (span <= 0 || Math.hypot(dx, dz) > TELEPORT_DISTANCE) return last.s;
    const ahead = Math.min(t - last.t, EXTRAPOLATE_MS);
    const k = ahead / span;
    return {
      ...last.s,
      x: last.s.x + dx * k,
      z: last.s.z + dz * k,
      speed: t - last.t >= EXTRAPOLATE_MS ? 0 : last.s.speed,
    };
  }
}
