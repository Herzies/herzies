import {
  type ChainBody,
  DISC_BOUNCE_S,
  DISC_HANG_S,
  DISC_OVERSHOOT,
  DISC_RANGE,
  DISC_SPEED,
  discBackS,
  nextInChain,
} from "@herzies/shared/combat";
import { SHUFFLE_REACH } from "@herzies/shared/skills";
import { DUMMY, type DummyState, waveHitsDummy } from "./dummy";
import { steer, type Vec3 } from "./waves";

/**
 * A Record Slinger's discs in flight: thrown from one hand, out straight
 * and fast along the aim, a beat's hang where they turn, and back along a
 * curve to the hand — wherever the hand is by then — to be caught. Only the
 * way out hits; a hit sends a disc straight back, so up close they come
 * round quicker. Under a Shuffle a hit sends it on instead, straight at the
 * nearest target it hasn't struck (as the server picks: nextInChain), so
 * many times; then home. A pool, stepped by Combat, drawn by vfx/DiscVFX.
 * Pure, so it's tested without a scene; nothing here allocates once it's
 * made, but for a Shuffle's bounce now and then.
 */

export const DISC = {
  /** Out: as fast as the server times it (DISC_SPEED), as far. */
  speed: DISC_SPEED,
  range: DISC_RANGE,
  /** How wide it is to a dummy (on top of the dummy's own radius). */
  hitRadius: 0.28,
  /** It's drawn toward a dummy, like a wave, but turns a little less. */
  homing: 2.6,
  /** Past its reach, how far it carries on as it slows, and how long it
   * hangs there turning (seconds): as the server times it. */
  overshoot: DISC_OVERSHOOT,
  hang: DISC_HANG_S,
  /** Off a hit, how far it bounces back, and how long that takes. */
  bounce: 0.6,
  bounceTime: DISC_BOUNCE_S,
  /** How far out to its hand's side the way back bows (a share of the
   * distance, and at most), and how high it rises. */
  bow: 0.22,
  bowMax: 3,
  lift: 0.35,
  /** Within this of the hand, it's caught. */
  catchRadius: 0.35,
  /** Bouncing on (Shuffle): its speed, as the server times it, and the
   * longest it chases one target before giving up and coming home. */
  hopSpeed: DISC_SPEED,
  hopMax: 1,
} as const;

/** How long a disc's sparks last. */
export const SPARK_SECONDS = 0.18;

/** The hand a disc is thrown from: the held part it sits in. */
export type DiscHand = "held-l" | "held-r";

/** The arm each hand is: "held-l" is the main hand (the casting arm). */
export const DISC_ARM = {
  "held-l": "arm-l",
  "held-r": "arm-r",
} as const satisfies Record<DiscHand, "arm-l" | "arm-r">;

/** Which way the way back bows for each hand, as seen from behind the
 * thrower (+1: their right). The main hand is on their right. */
export const DISC_SIDE: Record<DiscHand, 1 | -1> = {
  "held-l": 1,
  "held-r": -1,
};

export type Disc = {
  alive: boolean;
  /** Thrown by you (its hits count) or someone else (they only show). */
  mine: boolean;
  /** Whose it is (their herzie, or anything standing for them). */
  owner: object | null;
  hand: DiscHand;
  /** "out" along `dir`; "hop" on to the next target (Shuffle); "turn"
   * slowing to a stop (or bouncing off a hit); "back" to the hand. */
  phase: "out" | "hop" | "turn" | "back";
  pos: Vec3;
  /** Where it was last step. */
  prev: Vec3;
  /** Unit direction it was thrown (and steered) in. */
  dir: Vec3;
  /** How far it's come out, and how far it may. */
  travelled: number;
  reach: number;
  /** What's at the end of its reach, if not open air: a solid it strikes
   * there ("wall": a clink; "target": a hit the server counts, the boss). */
  strike: "wall" | "target" | null;
  /** The dummy it's drawn toward, if any. */
  target: DummyState | null;
  /** Seconds since it left the hand, and since its phase began. */
  age: number;
  t: number;
  /** Turning: from where, which way, how far and for how long. */
  turnFrom: Vec3;
  turnDir: Vec3;
  turnDist: number;
  turnTime: number;
  /** Back: from where, and how long it takes. */
  backFrom: Vec3;
  backTime: number;
  /** How much quicker it comes home: a hasted thrower's (1 + Haste). */
  quick: number;
  /** How many times it may bounce on (a Shuffle's), how many it has, what
   * it has struck (never twice), and what it's bouncing on to. */
  bounces: number;
  hops: number;
  struck: DummyState[];
  hopTo: DummyState | null;
};

/** A little flash: as it leaves the hand, as it turns, as it clinks off a
 * wall, as it's caught. */
export type Spark = {
  alive: boolean;
  pos: Vec3;
  age: number;
  kind: "throw" | "turn" | "clink" | "catch";
  /** Not yet seen by whatever throws motes off it; not yet heard. */
  fresh: boolean;
  heard: boolean;
};

/** A hit: `bounce` is 0 on the way out, then 1, 2… as it bounces on. */
export type DiscHit = {
  disc: Disc;
  dummy: DummyState;
  point: Vec3;
  bounce: number;
};

export type DiscHooks = {
  /** Where `disc`'s hand is now (world space), into `out`. */
  handAt(disc: Disc, out: Vec3): Vec3;
  /** It struck a dummy on its way out: says whether it was a crit. */
  onHit(hit: DiscHit): "crit" | "hit";
  /** It struck what it was thrown at, the end of its reach (the boss). */
  onStrike?(disc: Disc): void;
  /** It's back in the hand. */
  onCatch?(disc: Disc): void;
};

const vec = (): Vec3 => [0, 0, 0];
const pool = <T>(n: number, make: () => T) => Array.from({ length: n }, make);
const hand = vec();

export class DiscField {
  readonly discs = pool<Disc>(16, () => ({
    alive: false,
    mine: false,
    owner: null,
    hand: "held-l",
    phase: "out",
    pos: vec(),
    prev: vec(),
    dir: vec(),
    travelled: 0,
    reach: 0,
    strike: null,
    target: null,
    age: 0,
    t: 0,
    turnFrom: vec(),
    turnDir: vec(),
    turnDist: 0,
    turnTime: 0,
    backFrom: vec(),
    backTime: 0,
    quick: 1,
    bounces: 0,
    hops: 0,
    struck: [],
    hopTo: null,
  }));
  readonly sparks = pool<Spark>(24, () => ({
    alive: false,
    pos: vec(),
    age: 0,
    kind: "throw",
    fresh: false,
    heard: false,
  }));

  /** The hand each owner last threw from, so throws alternate. */
  private readonly lastHand = new WeakMap<object, DiscHand>();

  /** The hand `owner` last threw from, if any. */
  lastThrown(owner: object): DiscHand | undefined {
    return this.lastHand.get(owner);
  }

  /**
   * Throws a disc from `owner`'s `hand`, at `from`, along `dir` (normalised
   * here) for at most `reach`. A disc of theirs still out from that hand is
   * let go first: someone else's throws never wait on our idea of their
   * catches.
   */
  throw(
    from: Readonly<Vec3>,
    dir: Readonly<Vec3>,
    opts: {
      mine: boolean;
      owner: object;
      hand: DiscHand;
      reach?: number;
      strike?: Disc["strike"];
      target?: DummyState | null;
      /** Hasted: it comes home this much quicker (the way out is the
       * server's timing, so it stays as it is). */
      quick?: number;
      /** Under a Shuffle: how many times it bounces on from a hit. */
      bounces?: number;
    },
  ): Disc {
    for (const d of this.discs) {
      if (d.alive && d.owner === opts.owner && d.hand === opts.hand)
        d.alive = false;
    }
    this.lastHand.set(opts.owner, opts.hand);
    const d = take(this.discs, (a, b) => a.age > b.age);
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    d.alive = true;
    d.mine = opts.mine;
    d.owner = opts.owner;
    d.hand = opts.hand;
    d.phase = "out";
    set(d.pos, from);
    set(d.prev, from);
    d.dir[0] = dir[0] / len;
    d.dir[1] = dir[1] / len;
    d.dir[2] = dir[2] / len;
    d.travelled = 0;
    d.reach = Math.min(DISC.range, opts.reach ?? DISC.range);
    d.strike = opts.strike ?? null;
    d.target = opts.target ?? null;
    d.quick = Math.max(1, opts.quick ?? 1);
    d.bounces = Math.max(0, Math.floor(opts.bounces ?? 0));
    d.hops = 0;
    d.struck.length = 0;
    d.hopTo = null;
    d.age = 0;
    d.t = 0;
    this.spark(from, "throw");
    return d;
  }

  /** Whether `owner`'s disc from `hand` is away from it. */
  isOut(owner: object, hand: DiscHand): boolean {
    for (const d of this.discs)
      if (d.alive && d.owner === owner && d.hand === hand) return true;
    return false;
  }

  /** Everything `owner` has out, home at once (put away, gone through a
   * portal, knocked out, left): it vanishes with a glint where it was. */
  recall(owner: object): void {
    for (const d of this.discs) {
      if (!d.alive || d.owner !== owner) continue;
      d.alive = false;
      this.spark(d.pos, "turn");
    }
  }

  /** Moves everything on by `dt` seconds. */
  step(
    frameDt: number,
    dummies: readonly DummyState[],
    hooks: DiscHooks,
    /** Your own discs' pace through a crit's hit-stop (see WaveField). */
    mineScale = 1,
  ): void {
    for (const d of this.discs) {
      if (!d.alive) continue;
      const dt = d.mine ? frameDt * mineScale : frameDt;
      d.age += dt;
      d.t += dt;
      set(d.prev, d.pos);
      if (d.phase === "out") this.stepOut(d, dt, dummies, hooks);
      else if (d.phase === "hop") this.stepHop(d, dt, dummies, hooks);
      else if (d.phase === "turn") stepTurn(d);
      else this.stepBack(d, hooks);
    }
    age(this.sparks, frameDt, SPARK_SECONDS);
  }

  private stepOut(
    d: Disc,
    dt: number,
    dummies: readonly DummyState[],
    hooks: DiscHooks,
  ) {
    steer(d, dt, DISC.homing);
    const go = Math.min(DISC.speed * dt, d.reach - d.travelled);
    d.pos[0] += d.dir[0] * go;
    d.pos[1] += d.dir[1] * go;
    d.pos[2] += d.dir[2] * go;
    d.travelled += go;
    // The nearest dummy it passed into this step: hit, and bounce back.
    let best: { t: number; point: Vec3; dummy: DummyState } | null = null;
    for (const dm of dummies) {
      const hit = waveHitsDummy(dm, d.prev, d.pos, DISC.hitRadius);
      if (hit && (!best || hit.t < best.t)) best = { ...hit, dummy: dm };
    }
    if (best) {
      hooks.onHit({ disc: d, dummy: best.dummy, point: best.point, bounce: 0 });
      set(d.pos, best.point);
      d.struck.push(best.dummy);
      if (!this.hopOn(d, best.dummy, dummies)) bounce(d);
      return;
    }
    if (d.pos[1] < 0.05) {
      d.pos[1] = 0.05;
      this.spark(d.pos, "clink");
      bounce(d);
      return;
    }
    if (d.travelled < d.reach - 1e-6) return;
    if (d.strike === "target") {
      // The boss: never bounced on to, but it may bounce on from it.
      hooks.onStrike?.(d);
      if (!this.hopOn(d, d.pos, dummies)) bounce(d);
    } else if (d.strike === "wall") {
      this.spark(d.pos, "clink");
      bounce(d);
    } else {
      // Open air: it carries on a little, slowing, and hangs there.
      d.phase = "turn";
      d.t = 0;
      set(d.turnFrom, d.pos);
      set(d.turnDir, d.dir);
      d.turnDist = DISC.overshoot;
      d.turnTime = DISC.hang;
      this.spark(
        [
          d.pos[0] + d.dir[0] * DISC.overshoot,
          d.pos[1] + d.dir[1] * DISC.overshoot,
          d.pos[2] + d.dir[2] * DISC.overshoot,
        ],
        "turn",
      );
    }
  }

  /** Under a Shuffle with bounces left: on from `from` (a dummy, or a
   * point) to the nearest target not yet struck, if one is in reach. */
  private hopOn(
    d: Disc,
    from: DummyState | Readonly<Vec3>,
    dummies: readonly DummyState[],
  ): boolean {
    if (d.hops >= d.bounces) return false;
    const at = "key" in from ? from : { x: from[0], z: from[2] };
    const next = nextInChain(at, chainBodies(dummies), d.struck, SHUFFLE_REACH);
    if (!next) return false;
    d.phase = "hop";
    d.t = 0;
    d.hopTo = next.body.ref;
    // A glint (and its sound) where it turns on.
    this.spark(d.pos, "turn");
    return true;
  }

  private stepHop(
    d: Disc,
    dt: number,
    dummies: readonly DummyState[],
    hooks: DiscHooks,
  ) {
    const dm = d.hopTo;
    // Gone (fallen, left) or out of reach for too long: home.
    if (!dm || !dummies.includes(dm) || d.t > DISC.hopMax) {
      d.hopTo = null;
      bounce(d);
      return;
    }
    const radius = DUMMY.radius * (dm.size ?? 1);
    const tx = dm.x - d.pos[0];
    const ty = (dm.y ?? 0) + DUMMY.chest - d.pos[1];
    const tz = dm.z - d.pos[2];
    const dist = Math.hypot(tx, ty, tz) || 1;
    d.dir[0] = tx / dist;
    d.dir[1] = ty / dist;
    d.dir[2] = tz / dist;
    const go = DISC.hopSpeed * dt;
    if (go < dist - radius) {
      d.pos[0] += d.dir[0] * go;
      d.pos[1] += d.dir[1] * go;
      d.pos[2] += d.dir[2] * go;
      return;
    }
    // There: onto its surface, struck, and on again (or home).
    const k = Math.max(0, dist - radius);
    d.pos[0] += d.dir[0] * k;
    d.pos[1] += d.dir[1] * k;
    d.pos[2] += d.dir[2] * k;
    d.hops++;
    d.struck.push(dm);
    d.hopTo = null;
    hooks.onHit({ disc: d, dummy: dm, point: [...d.pos], bounce: d.hops });
    if (!this.hopOn(d, dm, dummies)) bounce(d);
  }

  private stepBack(d: Disc, hooks: DiscHooks) {
    hooks.handAt(d, hand);
    // How long the way back takes is fixed as it starts, from how far the
    // hand is then: the hand can move on, and it still arrives on time.
    if (d.backTime === 0) {
      d.backTime =
        backTime(
          Math.hypot(
            hand[0] - d.backFrom[0],
            hand[1] - d.backFrom[1],
            hand[2] - d.backFrom[2],
          ),
        ) / d.quick;
    }
    const u = Math.min(1, d.t / d.backTime);
    // Slow off the turn, fast into the hand.
    const e = u * u;
    curve(d, hand, e, d.pos);
    const near = Math.hypot(
      hand[0] - d.pos[0],
      hand[1] - d.pos[1],
      hand[2] - d.pos[2],
    );
    if (u >= 1 || (u > 0.5 && near < DISC.catchRadius)) {
      d.alive = false;
      set(d.pos, hand);
      this.spark(hand, "catch");
      hooks.onCatch?.(d);
    }
  }

  private spark(at: Readonly<Vec3>, kind: Spark["kind"]) {
    const s = take(this.sparks, (a, b) => a.age > b.age);
    s.alive = true;
    set(s.pos, at);
    s.age = 0;
    s.kind = kind;
    s.fresh = true;
    s.heard = false;
  }

  /** Everything gone at once (leaving the island). */
  clear(): void {
    for (const list of [this.discs, this.sparks]) {
      for (const x of list) x.alive = false;
    }
  }
}

/** What a disc may bounce on to: every target, as the chain picks them. */
function chainBodies(dummies: readonly DummyState[]): ChainBody<DummyState>[] {
  return dummies.map((dm) => ({
    ref: dm,
    x: dm.x,
    z: dm.z,
    radius: DUMMY.radius * (dm.size ?? 1),
  }));
}

/** Off a hit (or a wall): a quick bounce back the way it came. */
function bounce(d: Disc) {
  d.phase = "turn";
  d.t = 0;
  d.target = null;
  set(d.turnFrom, d.pos);
  d.turnDir[0] = -d.dir[0];
  d.turnDir[1] = -d.dir[1];
  d.turnDir[2] = -d.dir[2];
  d.turnDist = DISC.bounce;
  d.turnTime = DISC.bounceTime;
}

/** Turning: eased out to a stop, then on its way back. */
function stepTurn(d: Disc) {
  const u = Math.min(1, d.t / d.turnTime);
  const k = d.turnDist * (1 - (1 - u) * (1 - u));
  d.pos[0] = d.turnFrom[0] + d.turnDir[0] * k;
  d.pos[1] = d.turnFrom[1] + d.turnDir[1] * k;
  d.pos[2] = d.turnFrom[2] + d.turnDir[2] * k;
  if (u < 1) return;
  d.phase = "back";
  d.t = 0;
  set(d.backFrom, d.pos);
  // Set on its first step back, from how far the hand is then.
  d.backTime = 0;
}

/**
 * Where a disc on its way back is, `e` (0–1) of the way from where it
 * turned to `to`: a quadratic curve bowed out to its hand's side (as seen
 * from behind the thrower, facing the way it was thrown) and lifted a
 * little. Recomputed from the hand each step, so it arrives wherever the
 * hand has got to.
 */
export function curve(d: Disc, to: Readonly<Vec3>, e: number, out: Vec3) {
  const a = d.backFrom;
  const dx = to[0] - a[0];
  const dy = to[1] - a[1];
  const dz = to[2] - a[2];
  const dist = Math.hypot(dx, dy, dz);
  // Their right, facing the way it was thrown: (−dir.z, 0, dir.x).
  const fl = Math.hypot(d.dir[0], d.dir[2]) || 1;
  const rx = -d.dir[2] / fl;
  const rz = d.dir[0] / fl;
  const bow = Math.min(DISC.bowMax, dist * DISC.bow) * DISC_SIDE[d.hand];
  const cx = a[0] + dx * 0.5 + rx * bow;
  const cy = a[1] + dy * 0.5 + Math.min(DISC.lift, dist * 0.05);
  const cz = a[2] + dz * 0.5 + rz * bow;
  const v = 1 - e;
  out[0] = v * v * a[0] + 2 * v * e * cx + e * e * to[0];
  out[1] = v * v * a[1] + 2 * v * e * cy + e * e * to[1];
  out[2] = v * v * a[2] + 2 * v * e * cz + e * e * to[2];
}

/** How long a disc takes back over `dist` (seconds): the server's
 * timing, a snap however far (discBackS). */
export function backTime(dist: number): number {
  return discBackS(dist);
}

/** Which hand throws next for `owner`: the other one from last time if its
 * disc is in it (the main hand first), else the same one again — or null
 * with both out (or without gear in a hand, `holds` says which it has). Up
 * close a disc is back before the next throw, so without the turn about
 * the main hand would throw every time. */
export function nextHand(
  field: DiscField,
  owner: object,
  holds: (hand: DiscHand) => boolean = () => true,
): DiscHand | null {
  const order: readonly DiscHand[] =
    field.lastThrown(owner) === "held-l"
      ? ["held-r", "held-l"]
      : ["held-l", "held-r"];
  for (const h of order) {
    if (holds(h) && !field.isOut(owner, h)) return h;
  }
  return null;
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

/** The one field the Town's discs fly in. */
export const discField = new DiscField();
