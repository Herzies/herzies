import {
  WAVE_ASSIST_ANGLE,
  WAVE_HIT_RADIUS,
  WAVE_RANGE,
  WAVE_SPEED,
} from "@herzies/shared/combat";
import { DUMMY, type DummyState, waveHitsDummy } from "./dummy";
import { entityAt } from "./skills";

/**
 * Sonic waves in flight, and what they leave behind: a pool, stepped by
 * the frame loop, drawn by vfx/SonicVFX. Pure, so it's tested without a
 * scene. Nothing here allocates once the pools are made.
 */

export const WAVE = {
  /** How fast a wave travels, world units a second. */
  speed: WAVE_SPEED,
  /** How far it goes before it's spent, if it hits nothing. */
  range: WAVE_RANGE,
  /** It spreads as it goes, as sound does: its front's radius at the hand,
   * and once it's spent. */
  startRadius: 0.22,
  endRadius: 1.15,
  /** How wide it is to a dummy (on top of the dummy's own radius). */
  hitRadius: WAVE_HIT_RADIUS,
  /** Aim assist: a dummy this close to the line of aim (radians, as seen
   * from the hand) draws the wave in… */
  assistAngle: WAVE_ASSIST_ANGLE,
  /** …turning it at most this fast (radians a second). */
  homing: 3.2,
  /** A wake ring is left this often along the way (seconds). */
  wakeEvery: 0.045,
} as const;

/** How long the things a wave leaves last, in seconds. */
export const IMPACT_SECONDS = 0.42;
export const WAKE_SECONDS = 0.32;
export const MUZZLE_SECONDS = 0.2;

export type Vec3 = [number, number, number];

export type Wave = {
  alive: boolean;
  /** Cast by you (its hits count) or someone else (they only show). */
  mine: boolean;
  pos: Vec3;
  /** Where it was last step. */
  prev: Vec3;
  /** Unit direction of travel. */
  dir: Vec3;
  /** How far it's come. */
  travelled: number;
  /** How far it can go: the range, or where the aim stopped on something
   * solid that isn't a dummy (it bursts there). */
  reach: number;
  /** The dummy it's drawn toward, if any. */
  target: DummyState | null;
  /** Its damage as a share of a plain cast's (a Backspin disc's is less). */
  scale: number;
  /** A Bard's heal bolt: green, through dummies, home on `ally` (an entity
   * id) and gone into it. */
  heal: boolean;
  ally: number | null;
  /** Seconds since it left the hand; and until the next wake ring. */
  age: number;
  wake: number;
};

/** A burst where a wave struck (or ended): an expanding shockwave. */
export type Impact = {
  alive: boolean;
  pos: Vec3;
  /** Which way it came from (the normal it splashes along). */
  dir: Vec3;
  age: number;
  /** A crit (bigger), a hit, a wave fizzling out against the world, or a
   * heal bolt landing on its ally. */
  kind: "crit" | "hit" | "fizzle" | "heal";
  /** Not yet seen by whatever throws sparks off it. */
  fresh: boolean;
};

/** A ring left in the air behind a wave, spreading and fading. */
export type Wake = {
  alive: boolean;
  pos: Vec3;
  dir: Vec3;
  age: number;
  radius: number;
  /** Left by a heal bolt (drawn green). */
  heal: boolean;
};

/** A flash at the hand as the wave leaves it. */
export type Muzzle = {
  alive: boolean;
  pos: Vec3;
  dir: Vec3;
  age: number;
  fresh: boolean;
};

export type Hit = {
  wave: Wave;
  dummy: DummyState;
  point: Vec3;
};

const vec = (): Vec3 => [0, 0, 0];
const pool = <T>(n: number, make: () => T) => Array.from({ length: n }, make);

export class WaveField {
  readonly waves = pool<Wave>(32, () => ({
    alive: false,
    mine: false,
    pos: vec(),
    prev: vec(),
    dir: vec(),
    travelled: 0,
    reach: 0,
    target: null,
    scale: 1,
    heal: false,
    ally: null,
    age: 0,
    wake: 0,
  }));
  readonly impacts = pool<Impact>(24, () => ({
    alive: false,
    pos: vec(),
    dir: vec(),
    age: 0,
    kind: "hit",
    fresh: false,
  }));
  readonly wakes = pool<Wake>(64, () => ({
    alive: false,
    pos: vec(),
    dir: vec(),
    age: 0,
    radius: 0,
    heal: false,
  }));
  readonly muzzles = pool<Muzzle>(8, () => ({
    alive: false,
    pos: vec(),
    dir: vec(),
    age: 0,
    fresh: false,
  }));

  /** Send a wave from `from` along `dir` (normalised here), for at most
   * `reach`; drawn toward `target` if given. Returns it (or null if every
   * slot is busy — then the oldest is reused). */
  cast(
    from: Readonly<Vec3>,
    dir: Readonly<Vec3>,
    opts: {
      mine: boolean;
      reach?: number;
      target?: DummyState | null;
      scale?: number;
      heal?: boolean;
      ally?: number | null;
    },
  ): Wave {
    const w = take(this.waves, (a, b) => a.age > b.age);
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    w.alive = true;
    w.mine = opts.mine;
    set(w.pos, from);
    set(w.prev, from);
    w.dir[0] = dir[0] / len;
    w.dir[1] = dir[1] / len;
    w.dir[2] = dir[2] / len;
    w.travelled = 0;
    w.reach = Math.min(WAVE.range, opts.reach ?? WAVE.range);
    w.target = opts.target ?? null;
    w.scale = opts.scale ?? 1;
    w.heal = !!opts.heal;
    w.ally = opts.ally ?? null;
    if (w.heal) w.target = null;
    w.age = 0;
    w.wake = WAVE.wakeEvery * 0.5;
    const m = take(this.muzzles, (a, b) => a.age > b.age);
    m.alive = true;
    set(m.pos, from);
    set(m.dir, w.dir);
    m.age = 0;
    m.fresh = true;
    return w;
  }

  /**
   * Moves everything on by `dt` seconds. A wave that reaches a dummy calls
   * `onHit` (which says whether it was a crit, for the burst's size) and
   * bursts there; one that runs out of reach fizzles.
   */
  step(
    dt: number,
    dummies: readonly DummyState[],
    onHit: (hit: Hit) => "crit" | "hit",
  ): void {
    for (const w of this.waves) {
      if (!w.alive) continue;
      w.age += dt;
      if (w.heal) {
        if (stepHeal(w, dt)) {
          this.burst(w.pos, w.dir, "heal");
          continue;
        }
      } else steer(w, dt);
      set(w.prev, w.pos);
      const go = Math.min(WAVE.speed * dt, w.reach - w.travelled);
      w.pos[0] += w.dir[0] * go;
      w.pos[1] += w.dir[1] * go;
      w.pos[2] += w.dir[2] * go;
      w.travelled += go;
      // The nearest dummy it passed into this step (a heal bolt passes
      // through them).
      let best: { t: number; point: Vec3; dummy: DummyState } | null = null;
      for (const d of w.heal ? [] : dummies) {
        const hit = waveHitsDummy(d, w.prev, w.pos, WAVE.hitRadius);
        if (hit && (!best || hit.t < best.t)) best = { ...hit, dummy: d };
      }
      if (best) {
        w.alive = false;
        const kind = onHit({ wave: w, dummy: best.dummy, point: best.point });
        this.burst(best.point, w.dir, kind);
        continue;
      }
      // Wake rings, spreading behind it.
      w.wake -= dt;
      if (w.wake <= 0) {
        w.wake += WAVE.wakeEvery;
        const k = take(this.wakes, (a, b) => a.age > b.age);
        k.alive = true;
        set(k.pos, w.pos);
        set(k.dir, w.dir);
        k.age = 0;
        k.radius = waveRadius(w) * 0.8;
        k.heal = w.heal;
      }
      if (w.travelled >= w.reach - 1e-6 || w.pos[1] < 0) {
        w.alive = false;
        // Short of its full range, it struck something (the ground, a tree).
        if (w.reach < WAVE.range || w.pos[1] < 0) {
          this.burst(w.pos, w.dir, "fizzle");
        }
      }
    }
    age(this.impacts, dt, IMPACT_SECONDS);
    age(this.wakes, dt, WAKE_SECONDS);
    age(this.muzzles, dt, MUZZLE_SECONDS);
  }

  /** A shockwave at `at`, from a wave travelling `dir`. */
  burst(at: Readonly<Vec3>, dir: Readonly<Vec3>, kind: Impact["kind"]): void {
    const i = take(this.impacts, (a, b) => a.age > b.age);
    i.alive = true;
    set(i.pos, at);
    set(i.dir, dir);
    i.age = 0;
    i.kind = kind;
    i.fresh = true;
  }

  /** Everything gone at once (leaving the island). */
  clear(): void {
    for (const list of [this.waves, this.impacts, this.wakes, this.muzzles]) {
      for (const x of list) x.alive = false;
    }
  }
}

/** How wide a wave's front is now: it spreads as it goes. */
export function waveRadius(w: Wave): number {
  const k = Math.min(1, w.travelled / WAVE.range);
  return WAVE.startRadius + (WAVE.endRadius - WAVE.startRadius) * Math.sqrt(k);
}

/**
 * The dummy a wave from `from` going `dir` would be drawn to: the one
 * nearest the line of aim, within the assist angle and in range — or null.
 */
export function assistTarget(
  from: Readonly<Vec3>,
  dir: Readonly<Vec3>,
  dummies: readonly DummyState[],
): DummyState | null {
  let best: DummyState | null = null;
  let bestAngle = WAVE.assistAngle;
  for (const d of dummies) {
    const tx = d.x - from[0];
    const ty = DUMMY.chest - from[1];
    const tz = d.z - from[2];
    const dist = Math.hypot(tx, ty, tz);
    if (dist < 1e-6 || dist > WAVE.range) continue;
    const cos = (tx * dir[0] + ty * dir[1] + tz * dir[2]) / dist;
    // Widened up close, so a dummy right in front is always in reach.
    const angle = Math.acos(Math.min(1, cos)) - Math.atan(DUMMY.radius / dist);
    if (angle < bestAngle) {
      bestAngle = angle;
      best = d;
    }
  }
  return best;
}

/** Turns a wave (or a disc on its way out) toward its target, a little
 * each step, at most `homing` radians a second. */
/** How hard a heal bolt turns toward its ally (radians a second): it
 * follows them, as a lock-on heal does. */
const HEAL_HOMING = 9;
/** Where on its ally a bolt goes in, as a share of its height. */
const HEAL_AT = 0.55;

/** A heal bolt's turn toward its ally; true once it's reached them (and
 * is spent). */
function stepHeal(w: Wave, dt: number): boolean {
  const a = w.ally === null ? undefined : entityAt.get(w.ally);
  if (!a) return false;
  const tx = a.x - w.pos[0];
  const ty = a.top * HEAL_AT - w.pos[1];
  const tz = a.z - w.pos[2];
  const len = Math.hypot(tx, ty, tz);
  if (len < 0.6) {
    w.alive = false;
    return true;
  }
  const k = Math.min(1, HEAL_HOMING * dt);
  w.dir[0] += (tx / len - w.dir[0]) * k;
  w.dir[1] += (ty / len - w.dir[1]) * k;
  w.dir[2] += (tz / len - w.dir[2]) * k;
  const l = Math.hypot(w.dir[0], w.dir[1], w.dir[2]) || 1;
  w.dir[0] /= l;
  w.dir[1] /= l;
  w.dir[2] /= l;
  // It never runs out on the way to someone it's locked on.
  w.reach = Math.max(w.reach, w.travelled + len + 1);
  return false;
}

export function steer(
  w: { pos: Vec3; dir: Vec3; target: DummyState | null },
  dt: number,
  homing: number = WAVE.homing,
) {
  const d = w.target;
  if (!d) return;
  const tx = d.x - w.pos[0];
  const ty = DUMMY.chest - w.pos[1];
  const tz = d.z - w.pos[2];
  const len = Math.hypot(tx, ty, tz);
  if (len < 0.5) return;
  const want: Vec3 = [tx / len, ty / len, tz / len];
  const cos = Math.min(
    1,
    want[0] * w.dir[0] + want[1] * w.dir[1] + want[2] * w.dir[2],
  );
  const angle = Math.acos(cos);
  if (angle < 1e-5) return;
  // Gone past it (or never close): let it go.
  if (cos < 0) {
    w.target = null;
    return;
  }
  const k = Math.min(1, (homing * dt) / angle);
  w.dir[0] += (want[0] - w.dir[0]) * k;
  w.dir[1] += (want[1] - w.dir[1]) * k;
  w.dir[2] += (want[2] - w.dir[2]) * k;
  const l = Math.hypot(w.dir[0], w.dir[1], w.dir[2]) || 1;
  w.dir[0] /= l;
  w.dir[1] /= l;
  w.dir[2] /= l;
}

function set(out: Vec3, v: Readonly<Vec3>) {
  out[0] = v[0];
  out[1] = v[1];
  out[2] = v[2];
}

/** A free slot, or else the one `older` says to give up. */
function take<T extends { alive: boolean }>(
  list: T[],
  older: (a: T, b: T) => boolean,
): T {
  let pick = list[0];
  for (const x of list) {
    if (!x.alive) return x;
    if (older(x, pick)) pick = x;
  }
  return pick;
}

function age<T extends { alive: boolean; age: number }>(
  list: T[],
  dt: number,
  life: number,
) {
  for (const x of list) {
    if (!x.alive) continue;
    x.age += dt;
    if (x.age >= life) x.alive = false;
  }
}

/** The one field the Town's waves fly in. */
export const waveField = new WaveField();
