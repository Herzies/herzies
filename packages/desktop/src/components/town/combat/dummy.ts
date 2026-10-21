import { cellCenter, facingAt, groundY, objectAt, type TownMap } from "../map";

/**
 * Training dummies: what they are to a wave (an upright capsule), how they
 * rock when hit (damped springs), and the damage meter each keeps. Pure,
 * so it's tested without a scene; Dummies.tsx draws them.
 */

/** A dummy's shape, in world units from the ground: the sack it's hit on
 * is a capsule round its post, from `bottom` to `top`. */
export const DUMMY = {
  radius: 0.48,
  bottom: 0.45,
  top: 2.05,
  /** Where it rocks from: the top of its base. */
  pivot: 0.14,
  /** The middle of what you'd aim at. */
  chest: 1.25,
} as const;

/** The rock about the base: a stiff, lightly damped spring, so a hit
 * sets it swinging and it settles over a second or so. */
const ROCK = { hz: 2.1, damping: 0.2, kick: 1.9, maxTilt: 0.55 } as const;
/** The head bobbles on its own, quicker and looser. */
const BOBBLE = { hz: 3.6, damping: 0.16, kick: 2.6, maxTilt: 0.5 } as const;
/** How long the hit flash lasts, in seconds. */
const FLASH_SECONDS = 0.12;
/** The meter clears this long after the last hit (ms) — the usual dummy
 * convention: stop hitting for a moment and it starts over. */
export const METER_RESET_MS = 5_000;

/** Two-axis spring state: tilt (radians about x and z) and its speed. */
type Spring = { x: number; z: number; vx: number; vz: number };
const spring = (): Spring => ({ x: 0, z: 0, vx: 0, vz: 0 });

export type Meter = {
  total: number;
  hits: number;
  crits: number;
  /** performance.now() of the first and last hit since it cleared. */
  firstAt: number;
  lastAt: number;
};
const emptyMeter = (): Meter => ({
  total: 0,
  hits: 0,
  crits: 0,
  firstAt: 0,
  lastAt: 0,
});

export type DummyState = {
  key: string;
  x: number;
  /** The ground it stands on (0 if not set). */
  y?: number;
  z: number;
  /** Which way it faces: forward is (sin, cos). */
  yaw: number;
  rock: Spring;
  bobble: Spring;
  /** 1 just hit, fading to 0. */
  flash: number;
  /** A squash on the hit, 0–1, easing back. */
  squash: number;
  /** Frozen for a beat on a crit (hit-stop), until this performance.now(). */
  frozenUntil: number;
  meter: Meter;
  /** A Tower mob standing in for a dummy (the server's id): waves aim at
   * it and burst on it, but the server says what they did. */
  mob?: number;
};

/** A fresh target at (x, z): a dummy, or a mob standing in for one. */
export function newTarget(
  key: string,
  x: number,
  z: number,
  yaw: number,
  mob?: number,
): DummyState {
  return {
    key,
    x,
    z,
    yaw,
    rock: spring(),
    bobble: spring(),
    flash: 0,
    squash: 0,
    frozenUntil: 0,
    meter: emptyMeter(),
    ...(mob !== undefined ? { mob } : {}),
  };
}

/** Every dummy on the map, facing the way it was turned (else the middle of
 * the island). */
export function dummiesOf(map: TownMap): DummyState[] {
  const out: DummyState[] = [];
  for (let row = 0; row < map.size; row++) {
    for (let col = 0; col < map.size; col++) {
      if (objectAt(map, col, row) !== "D") continue;
      const [x, z] = cellCenter(map, col, row);
      out.push({
        ...newTarget(
          `${col},${row}`,
          x,
          z,
          facingAt(map, col, row) ?? Math.atan2(-x, -z),
        ),
        y: groundY(map, x, z),
      });
    }
  }
  return out;
}

function stepSpring(
  s: Spring,
  k: { hz: number; damping: number; maxTilt: number },
  dt: number,
) {
  const w = 2 * Math.PI * k.hz;
  const c = 2 * k.damping * w;
  // Semi-implicit Euler, in small steps so a long frame can't blow it up.
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    s.vx += (-w * w * s.x - c * s.vx) * h;
    s.vz += (-w * w * s.z - c * s.vz) * h;
    s.x += s.vx * h;
    s.z += s.vz * h;
  }
  s.x = Math.max(-k.maxTilt, Math.min(k.maxTilt, s.x));
  s.z = Math.max(-k.maxTilt, Math.min(k.maxTilt, s.z));
}

/** Rocks and fades it on by `dt` seconds (held still while frozen). */
export function stepDummy(d: DummyState, dt: number, now: number): void {
  if (now < d.frozenUntil) return;
  stepSpring(d.rock, ROCK, dt);
  stepSpring(d.bobble, BOBBLE, dt);
  d.flash = Math.max(0, d.flash - dt / FLASH_SECONDS);
  d.squash *= Math.exp(-14 * dt);
}

/** It's hit, by a wave travelling (dx, dz) on the ground, for `amount`:
 * it rocks away from the hit — harder for a bigger one — flashes and
 * squashes; a crit holds it still for a beat first. `count` false (another
 * player's wave) leaves the meter alone. */
export function hitDummy(
  d: DummyState,
  dx: number,
  dz: number,
  amount: number,
  crit: boolean,
  now: number,
  count = true,
): void {
  const len = Math.hypot(dx, dz) || 1;
  // A push along +z tips the top toward +z: a turn about +x. Along +x, a
  // turn about −z. In the dummy's own frame, so it rocks the right way
  // whichever way it faces.
  const c = Math.cos(-d.yaw);
  const s = Math.sin(-d.yaw);
  const lx = (dx * c + dz * s) / len;
  const lz = (-dx * s + dz * c) / len;
  const force = (0.6 + Math.min(2, amount / 100) * 0.4) * (crit ? 1.6 : 1);
  d.rock.vx += lz * ROCK.kick * force;
  d.rock.vz -= lx * ROCK.kick * force;
  d.bobble.vx += lz * BOBBLE.kick * force;
  d.bobble.vz -= lx * BOBBLE.kick * force;
  d.flash = 1;
  d.squash = crit ? 1 : 0.6;
  if (crit) d.frozenUntil = now + 70;
  if (!count) return;
  const m = d.meter;
  if (m.hits === 0 || now - m.lastAt > METER_RESET_MS) {
    Object.assign(m, emptyMeter(), { firstAt: now });
  }
  m.total += amount;
  m.hits++;
  if (crit) m.crits++;
  m.lastAt = now;
}

/** Damage per second since the first hit: over at least a second, so the
 * first hit doesn't read as a huge spike. */
export function meterDps(m: Meter, now: number): number {
  if (m.hits === 0) return 0;
  return m.total / Math.max(1, (now - m.firstAt) / 1000);
}

/** Whether the meter has gone quiet long enough to clear. */
export function meterIdle(m: Meter, now: number): boolean {
  return m.hits === 0 || now - m.lastAt > METER_RESET_MS;
}

/**
 * Where a wave moving from `a` to `b` (world points), `r` wide, first
 * touches a dummy: how far along (0–1) and the point on the dummy's
 * surface it reached — or null if it passes by. The dummy is a vertical
 * capsule round its post.
 */
export function waveHitsDummy(
  d: DummyState,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  r: number,
): { t: number; point: [number, number, number] } | null {
  // Closest approach of segment ab to the capsule's axis (the vertical
  // segment from bottom to top), by the usual segment–segment solution.
  const p1 = a;
  const d1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const base = d.y ?? 0;
  const p2 = [d.x, base + DUMMY.bottom, d.z];
  const d2 = [0, DUMMY.top - DUMMY.bottom, 0];
  const r0 = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]];
  const dot = (u: number[], v: number[]) =>
    u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const aa = dot(d1, d1);
  const ee = dot(d2, d2);
  const ff = dot(d2, r0);
  const reach = DUMMY.radius + r;
  if (aa < 1e-12) return null;
  const cc = dot(d1, r0);
  const bb = dot(d1, d2);
  const denom = aa * ee - bb * bb;
  let s = denom > 1e-12 ? clamp01((bb * ff - cc * ee) / denom) : 0;
  let t = (bb * s + ff) / ee;
  if (t < 0) {
    t = 0;
    s = clamp01(-cc / aa);
  } else if (t > 1) {
    t = 1;
    s = clamp01((bb - cc) / aa);
  }
  const c1 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const c2 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  const gap = Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]);
  if (gap > reach) return null;
  // Back up along the path to where it first touched, roughly: the
  // distance to give back, over how fast the gap closes.
  const len = Math.sqrt(aa);
  const back = Math.sqrt(Math.max(0, reach * reach - gap * gap)) / len;
  const hitT = Math.max(0, s - back);
  const at = [p1[0] + d1[0] * hitT, p1[1] + d1[1] * hitT, p1[2] + d1[2] * hitT];
  // Onto the sack's surface, toward where it came from.
  const axisY = Math.min(
    base + DUMMY.top,
    Math.max(base + DUMMY.bottom, at[1]),
  );
  const ox = at[0] - d.x;
  const oz = at[2] - d.z;
  const ol = Math.hypot(ox, oz) || 1;
  return {
    t: hitT,
    point: [
      d.x + (ox / ol) * DUMMY.radius,
      axisY,
      d.z + (oz / ol) * DUMMY.radius,
    ],
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
