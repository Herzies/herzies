/**
 * What a sonic wave does. Kept apart from the item catalog so the Town
 * server (a Worker) can roll a cast's damage without bundling it; `items.ts`
 * re-exports these, so the rest of the app imports them from the same place
 * as before.
 */

/** The stats a hit reads. */
export type HitStats = {
  sonicPower: number;
  critChance: number;
  critDamage: number;
  /** Quickens attacks (see timingAttackSpeed); its crit chance is already
   * in critChance. Absent, none. */
  timing?: number;
};

/** What one sonic wave deals before sonic power: the training dummies'
 * numbers. */
export const HIT_BASE = 100;
/** How far a hit's damage wanders either way of its base, as a fraction. */
export const HIT_SPREAD = 0.1;

/** How often a herzie casts a sonic wave, in ms: the client's pace, which
 * the Town server holds it to (with some slack for network jitter). */
export const CAST_INTERVAL_MS = 500;

/** What one wave deals at this sonic power, before its spread and crits:
 * the number a player is shown as their damage. */
export function waveDamage(sonicPower: number): number {
  return Math.round(HIT_BASE * (1 + sonicPower / 100));
}

/** One hit of a herzie's sonic wave: the base, raised by sonic power the
 * way boss damage is (10 sonic power is +10%), wandering ±HIT_SPREAD; and,
 * at crit chance percent, a critical hit — crit damage percent on top.
 * `rand` is two uniform [0, 1) draws (spread, then crit), so a test can
 * pin them. */
export function hitDamage(
  stats: HitStats,
  rand: () => number = Math.random,
): { amount: number; crit: boolean } {
  const spread = 1 + (rand() * 2 - 1) * HIT_SPREAD;
  const crit = rand() < stats.critChance / 100;
  const amount =
    HIT_BASE *
    (1 + stats.sonicPower / 100) *
    spread *
    (crit ? 1 + stats.critDamage / 100 : 1);
  return { amount: Math.round(amount), crit };
}

// ---------------------------------------------------------------------------
// Waves in flight, as the Town server and the desktop both need them

/** How fast a wave travels, world units a second. */
export const WAVE_SPEED = 26;
/** How far it goes before it's spent, if it hits nothing. */
export const WAVE_RANGE = 42;
/** Aim assist: a target this close to the line of aim (radians, seen from
 * the hand) draws the wave in. */
export const WAVE_ASSIST_ANGLE = (3 * Math.PI) / 180;
/** How wide a wave is to what it hits, on top of the target's own radius. */
export const WAVE_HIT_RADIUS = 0.2;
/** Height of the hand a wave leaves from, above the herzie's feet. */
export const WAVE_HAND_HEIGHT = 1.2;

// ---------------------------------------------------------------------------
// Discs: the Record Slinger's attack. Thrown, they fly out straight and come
// back to the hand; only the way out hits, so the server times a hit the way
// it does a wave's, at the disc's own speed and reach.

/** How fast a disc flies out, world units a second. */
export const DISC_SPEED = 30;
/** How far a disc flies before it turns back, if it hits nothing. */
export const DISC_RANGE = 24;
/** A disc's hit as a share of a wave's: a little more, for the wait while
 * it comes back. */
export const DISC_DAMAGE = 1.15;

/** How long after the throw a disc that hits at `dist` lands, in ms. */
export function discLandsAfterMs(dist: number): number {
  return (dist / DISC_SPEED) * 1000;
}

/** A disc's way back to the hand: a snap, quick however far it went (a
 * base and a little a metre, at most a ceiling), so a Slinger keeps its
 * pace out to most of its reach and only eases off at the far end of it
 * (about 85% at full reach), rather than falling off a cliff. In seconds,
 * before attack speed (which shortens it). */
export const DISC_BACK = { base: 0.16, perMetre: 0.006, max: 1.2 } as const;
/** Off a hit, how long its bounce takes before it turns for home (s). */
export const DISC_BOUNCE_S = 0.08;
/** Past its reach with nothing hit: how far it carries on and how long
 * it hangs there turning (world units, s). */
export const DISC_OVERSHOOT = 0.8;
export const DISC_HANG_S = 0.11;

/** How long a disc takes back from `dist` away, in seconds, at attack
 * speed `quick` (1: unhasted). */
export function discBackS(dist: number, quick = 1): number {
  return (
    Math.min(
      DISC_BACK.max,
      DISC_BACK.base + Math.max(0, dist) * DISC_BACK.perMetre,
    ) / Math.max(1e-3, quick)
  );
}

/**
 * How long a thrown disc is out of the hand, in ms: out to what it hits
 * at `hitDist` (null: nothing, so to its full reach, a carry and a hang),
 * the bounce, and back. A hand can throw again once it's back, so with two
 * hands this sets how fast a Slinger may throw at a range. The server
 * holds a Slinger to it, with slack; the client flies its discs by the
 * same numbers.
 */
export function discCycleMs(hitDist: number | null, quick = 1): number {
  const s =
    hitDist === null
      ? DISC_RANGE / DISC_SPEED +
        DISC_OVERSHOOT / DISC_SPEED +
        DISC_HANG_S +
        discBackS(DISC_RANGE + DISC_OVERSHOOT, quick)
      : hitDist / DISC_SPEED + DISC_BOUNCE_S + discBackS(hitDist, quick);
  return s * 1000;
}

/** Something a bouncing disc may go on to: where it stands, and how wide
 * it is (the leg ends at its surface). */
export type ChainBody<T> = { ref: T; x: number; z: number; radius: number };

/**
 * Where a disc under a Shuffle goes on to from `from`: the nearest body not
 * yet in `struck` (by ref) within `reach` of it, centre to centre on the
 * ground; and how far it flies to get there, to the body's surface. Null if
 * nothing is in reach. The server and the client both pick this way, so
 * the bounce drawn is the bounce judged.
 */
export function nextInChain<T>(
  from: { x: number; z: number },
  bodies: readonly ChainBody<T>[],
  struck: readonly T[],
  reach: number,
): { body: ChainBody<T>; dist: number } | null {
  let best: { body: ChainBody<T>; dist: number; centre: number } | null = null;
  for (const b of bodies) {
    if (struck.includes(b.ref)) continue;
    const centre = Math.hypot(b.x - from.x, b.z - from.z);
    if (centre > reach) continue;
    if (!best || centre < best.centre)
      best = { body: b, dist: Math.max(0, centre - b.radius), centre };
  }
  return best && { body: best.body, dist: best.dist };
}

/**
 * A disc's whole chain, as the server judges it at the throw: from what it
 * hit first (`first`, at `from`), up to `bounces` more bodies, each the
 * nearest not yet struck to the last. Each leg's flight distance; the
 * chain stops early when nothing's in reach.
 */
export function discChain<T>(
  first: T | null,
  from: { x: number; z: number },
  bodies: readonly ChainBody<T>[],
  bounces: number,
  reach: number,
): { body: ChainBody<T>; dist: number }[] {
  const out: { body: ChainBody<T>; dist: number }[] = [];
  const struck: T[] = first === null ? [] : [first];
  let at = from;
  for (let i = 0; i < bounces; i++) {
    const next = nextInChain(at, bodies, struck, reach);
    if (!next) break;
    out.push(next);
    struck.push(next.body.ref);
    at = next.body;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Cymbrella's dome: a shelter that stays where it's cast. It grows from
// around its caster to its full size, shoving every enemy out before it;
// while it stands, no enemy may enter, and nobody inside is hurt. The
// server judges it; the client draws it from the same numbers.

export const DOME = {
  /** Its full radius on the ground, world units. */
  radius: 4,
  /** How big it starts (round the caster), and how long it takes to grow. */
  startRadius: 0.8,
  growMs: 400,
} as const;

/** A dome standing at (x, z) from `from` to `until` (server ms). */
export type Dome = { x: number; z: number; from: number; until: number };

/** How far a dome reaches at `t`: easing out from its start to its full
 * size (quick at first, settling in), and 0 before or after it stands. */
export function domeRadiusAt(d: Dome, t: number): number {
  if (t < d.from || t >= d.until) return 0;
  const u = Math.min(1, (t - d.from) / DOME.growMs);
  const e = 1 - (1 - u) ** 3;
  return DOME.startRadius + (DOME.radius - DOME.startRadius) * e;
}

/** The dome that shelters (x, z) at `t`, if any. */
export function insideDome<D extends Dome>(
  domes: readonly D[],
  x: number,
  z: number,
  t: number,
): D | null {
  for (const d of domes) {
    const r = domeRadiusAt(d, t);
    if (r > 0 && Math.hypot(x - d.x, z - d.z) <= r) return d;
  }
  return null;
}

/**
 * Where a body `radius` wide at (x, z) must stand at `t` to be outside
 * every dome: straight out from the dome it's in, to just past its edge
 * (one dead on the centre goes out along +z). `bound`, if given, keeps it
 * where it may stand (the arena, the boss's wander circle). Where that
 * can't be had straight out (against a wall, or between two domes), it's
 * the nearest spot round the domes' edges that's both; and if there's none
 * at all, staying out of the dome wins, so the two never fight over it.
 */
export function pushOutOfDomes(
  domes: readonly Dome[],
  x: number,
  z: number,
  radius: number,
  t: number,
  bound?: (p: { x: number; z: number }) => { x: number; z: number },
): { x: number; z: number } {
  const live = domes.filter((d) => domeRadiusAt(d, t) > 0);
  const reachOf = (d: Dome) => domeRadiusAt(d, t) + radius;
  const clear = (p: { x: number; z: number }) =>
    live.every((d) => Math.hypot(p.x - d.x, p.z - d.z) >= reachOf(d) - 1e-6);
  const kept = (p: { x: number; z: number }) => {
    if (!bound) return true;
    const b = bound(p);
    return Math.hypot(b.x - p.x, b.z - p.z) < 1e-6;
  };
  const here = { x, z };
  if (clear(here)) return here;
  // Straight out of the dome it's deepest in.
  let worst = live[0];
  let depth = Number.NEGATIVE_INFINITY;
  for (const d of live) {
    const k = reachOf(d) - Math.hypot(x - d.x, z - d.z);
    if (k > depth) {
      depth = k;
      worst = d;
    }
  }
  const out = edgePoint(worst, reachOf(worst), x, z);
  if (clear(out) && kept(out)) return out;
  // Else the nearest spot round any dome's edge that's clear of them all
  // and in bounds; failing bounds, clear of them all.
  let best: { x: number; z: number } | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  let loose: { x: number; z: number } | null = null;
  let looseD = Number.POSITIVE_INFINITY;
  for (const d of live) {
    const reach = reachOf(d);
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const p = {
        x: d.x + Math.sin(a) * (reach + 1e-3),
        z: d.z + Math.cos(a) * (reach + 1e-3),
      };
      if (!clear(p)) continue;
      const dist = Math.hypot(p.x - x, p.z - z);
      if (dist < looseD) {
        looseD = dist;
        loose = p;
      }
      if (dist < bestD && kept(p)) {
        bestD = dist;
        best = p;
      }
    }
  }
  return best ?? loose ?? out;
}

/** Just past `d`'s edge (`reach` out), straight out through (x, z). */
function edgePoint(
  d: { x: number; z: number },
  reach: number,
  x: number,
  z: number,
): { x: number; z: number } {
  const dx = x - d.x;
  const dz = z - d.z;
  const dist = Math.hypot(dx, dz);
  const ux = dist > 1e-6 ? dx / dist : 0;
  const uz = dist > 1e-6 ? dz / dist : 1;
  return { x: d.x + ux * (reach + 1e-3), z: d.z + uz * (reach + 1e-3) };
}

/** A stun's length on a target stunned `recent` times in the
 * diminishing-returns window: halved each time. */
export function stunMs(base: number, recent: number): number {
  return base / 2 ** Math.max(0, recent);
}

// ---------------------------------------------------------------------------
// Melee: a Percussionist's stick, or an unarmed herzie's punch or body slam. Up
// close, ahead of it, and only at the moment of contact: the client tells
// the server when it lands, so there's no flight time.

/** How far past its own middle and the target's surface a melee hit
 * reaches, on the ground, in world units. */
export const MELEE_REACH = 1.6;
/** How far either way of where it faces a melee hit reaches (radians). */
export const MELEE_ARC = (60 * Math.PI) / 180;
/** A Percussionist's stick as a share of a wave's: more, for standing in
 * the boss's face to land it, though still short of the Record Slinger
 * (about 60% of its damage in raid-sim, with its discs, in-tune bonus and
 * skills). */
export const STRIKE_DAMAGE = 1.5;
/** A melee blow cleaves through everything in its arc, but only the first
 * thing it meets (the nearest, or the boss) takes it in full; the rest take
 * this share. A tank's cleave spreads its hold over a pack, not damage
 * enough to out-clear the damage class. */
export const MELEE_CLEAVE = 0.5;
/** A herzie without its instrument (or a class) slams its body into it:
 * the weakest blow there is, so a class and its instrument are a step up. */
export const BUMP_DAMAGE = 0.5;
/** A stage 3+ herzie without its instrument punches: a little better than a
 * body slam, well short of an instrument. */
export const PUNCH_DAMAGE = 0.6;

// ---------------------------------------------------------------------------
// Contribution: how much a herzie did for a boss fight, which ranks its end
// screen, rewards, statue and leaderboard. Damage counts as it is; healing
// and what a Cymbrella blocked count this many times over, because a heal is
// worth far more than a hit (a level-30 Bard restores a few dozen HP a
// second, Drones and heal bolts together, while a Record Slinger deals some
// 800). Holding the boss with a Taunt counts too, per
// second held (see tauntPointsPerSecond). Mirrored by boss_contribution in
// 00111 and 00142.

/** How many points of damage one HP healed or blocked is worth. */
export const CONTRIBUTION_SUPPORT_WEIGHT = 10;

/** A second of holding the boss with a Taunt is worth this many times what
 * an average herzie deals in a second of a fight that runs to
 * {@link TAUNT_FIGHT_SECONDS}: a Percussionist who holds it most of the
 * fight (two trading it) ranks with the damage dealers, not below them. */
export const TAUNT_CONTRIBUTION_WEIGHT = 1.5;
/** The fight length a taunt's worth is sized from (the raid's target). */
export const TAUNT_FIGHT_SECONDS = 390;

/** Points a second held with a Taunt is worth, for a boss of `maxHp` and a
 * roster of `roster`: from the boss's health, so a bigger boss pays more. */
export function tauntPointsPerSecond(maxHp: number, roster: number): number {
  if (!(maxHp > 0)) return 0;
  return (
    (TAUNT_CONTRIBUTION_WEIGHT * maxHp) /
    Math.max(1, Math.floor(roster) || 1) /
    TAUNT_FIGHT_SECONDS
  );
}

/** What a herzie did for a fight: damage dealt to the boss, HP healed, HP
 * blocked, damage dealt to its minions (`adds`: counted like boss damage
 * for the ranking, but never taken off the boss's health), and the points
 * holding the boss with a Taunt earned (`taunt`, already in points). */
export type Contribution = {
  damage: number;
  healing: number;
  blocked: number;
  adds?: number;
  taunt?: number;
};

/** A herzie's contribution score. */
export function contributionOf(c: Contribution): number {
  return (
    c.damage +
    (c.adds ?? 0) +
    (c.taunt ?? 0) +
    CONTRIBUTION_SUPPORT_WEIGHT * (c.healing + c.blocked)
  );
}

/** A melee hit as a share of a wave's, by blow (classes.ts MeleeBlow). */
export function meleeDamage(blow: "strike" | "punch" | "bump"): number {
  return blow === "strike"
    ? STRIKE_DAMAGE
    : blow === "punch"
      ? PUNCH_DAMAGE
      : BUMP_DAMAGE;
}

/** Whether a melee hit from `from`, facing `yaw`, reaches `target` (a
 * circle on the ground): within `reach` of its surface, and within the
 * arc of the way it faces. Right on top of it, it always does. */
export function meleeReaches(
  from: { x: number; z: number },
  yaw: number,
  target: { x: number; z: number; radius: number },
  reach: number = MELEE_REACH,
): boolean {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const dist = Math.hypot(dx, dz);
  if (dist - target.radius > reach) return false;
  if (dist <= target.radius) return true;
  let off = Math.atan2(dx, dz) - yaw;
  off = Math.atan2(Math.sin(off), Math.cos(off));
  // The target's own width counts toward the arc.
  return (
    Math.abs(off) - Math.asin(Math.min(1, target.radius / dist)) <= MELEE_ARC
  );
}

export type Vec3 = [number, number, number];

/** The unit direction of a cast, from the yaw and pitch a client sends. */
export function aimDirection(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return [c * Math.sin(yaw), Math.sin(pitch), c * Math.cos(yaw)];
}

// ---------------------------------------------------------------------------
// Heal bolts: a Bard's lute in its heal stance. The same pace as its waves
// (no cooldown), but each one heals the herzie it's aimed at instead of
// hurting anything. Soft-locked, as healers' aim is in action games (Ana,
// Mercy, Guild Wars 2): the ally nearest the line of aim within a cone.

/** What a heal bolt restores: this share of its target's max health, before
 * Euphony and an in-tune boost. Two a second from one Bard is about a
 * slam's worth every few seconds: a healer matters, without one Bard
 * outhealing the whole boss. */
export const HEAL_BOLT = 0.018;
/** How far either way of the aim a bolt finds its ally (radians): the
 * client's lock, and a little more on the server (its picture of where the
 * ally stood is a moment off). */
export const HEAL_LOCK_ANGLE = (8 * Math.PI) / 180;
export const HEAL_LOCK_SLACK = (3 * Math.PI) / 180;
/** Where a bolt aims on a herzie: its chest, above its feet. */
export const HEAL_TARGET_HEIGHT = 1;

/**
 * The ally a heal bolt from `from` along `dir` (unit) goes to: the one
 * nearest the line of aim, within `angle` (plus a little for a near ally's
 * width) and the wave's range. Null if nobody is.
 */
export function healTarget<T extends { x: number; z: number }>(
  from: Readonly<Vec3>,
  dir: Readonly<Vec3>,
  allies: Iterable<T>,
  angle: number = HEAL_LOCK_ANGLE,
): { ally: T; dist: number } | null {
  let best: { ally: T; dist: number } | null = null;
  let bestOff = Number.POSITIVE_INFINITY;
  for (const a of allies) {
    const vx = a.x - from[0];
    const vy = HEAL_TARGET_HEIGHT - from[1];
    const vz = a.z - from[2];
    const dist = Math.hypot(vx, vy, vz);
    if (dist < 0.3 || dist > WAVE_RANGE) continue;
    const cos = (vx * dir[0] + vy * dir[1] + vz * dir[2]) / dist;
    const off = Math.acos(Math.max(-1, Math.min(1, cos)));
    // A near ally is wide: its body counts, as much as 0.6 either side.
    const allow = angle + Math.atan(0.6 / dist);
    if (off <= allow && off < bestOff) {
      bestOff = off;
      best = { ally: a, dist };
    }
  }
  return best;
}

/** The yaw and pitch of a unit direction (the inverse of aimDirection). */
export function aimAngles(dir: Readonly<Vec3>): { yaw: number; pitch: number } {
  return {
    yaw: Math.atan2(dir[0], dir[2]),
    pitch: Math.asin(Math.max(-1, Math.min(1, dir[1]))),
  };
}

/**
 * How far along `dir` from `from` a wave reaches `target` (a sphere), if
 * the cast would find it: dead on, or within the aim assist (widened up
 * close, so a target right in front is always in reach). Null if it misses
 * or is out of range. The client draws waves toward the same targets with
 * the same rule, so what a player sees land is what the server counts.
 */
export function waveReaches(
  from: Readonly<Vec3>,
  dir: Readonly<Vec3>,
  target: { x: number; y: number; z: number; radius: number },
  range: number = WAVE_RANGE,
): number | null {
  const tx = target.x - from[0];
  const ty = target.y - from[1];
  const tz = target.z - from[2];
  const dist = Math.hypot(tx, ty, tz);
  if (dist < 1e-6 || dist > range) return null;
  const cos = (tx * dir[0] + ty * dir[1] + tz * dir[2]) / dist;
  const angle =
    Math.acos(Math.min(1, Math.max(-1, cos))) -
    Math.atan((target.radius + WAVE_HIT_RADIUS) / dist);
  return angle <= WAVE_ASSIST_ANGLE ? dist : null;
}

/** The boss in its cave: where it rests (and stands in the lobby) and how
 * big it is, for the Town server's hit test and the desktop's drawing and
 * collider alike. In a fight it walks (see BOSS_WANDER in boss-fight.ts), so
 * where it is comes from the server; these are its home and its size. */
export const BOSS_STAND = {
  x: 0,
  z: -4,
  /** Its body's radius on the ground, the height of its middle, and of
   * its top. */
  radius: 2.2,
  chest: 2.4,
  top: 4.8,
} as const;

/**
 * How far along `dir` from `from` a cast reaches the boss standing at `at`
 * (its home by default), if it does: at
 * its chest by the wave rule (aim assist and all), or anywhere on its body,
 * a standing cylinder as tall as it is. Up close the crosshair sits on the
 * near side of a big body, low or off to one side, well off the line to its
 * chest, so the chest alone would let those throws through. Null if it
 * misses or is out of range.
 */
export function bossReaches(
  from: Readonly<Vec3>,
  dir: Readonly<Vec3>,
  range: number = WAVE_RANGE,
  at: { x: number; z: number } = BOSS_STAND,
): number | null {
  return bodyHitAt(from, dir, { ...BOSS_STAND, x: at.x, z: at.z }, range);
}

/** A standing body a cast can hit: where it stands, its radius, the height
 * of its middle and of its top. */
export type Body = {
  x: number;
  z: number;
  radius: number;
  chest: number;
  top: number;
};

/** {@link bossReaches} for any standing body (a Tower mob): at its middle
 * by the wave rule, or anywhere on it. */
export function bodyHitAt(
  from: Readonly<Vec3>,
  dir: Readonly<Vec3>,
  b: Body,
  range: number = WAVE_RANGE,
): number | null {
  const chest = waveReaches(
    from,
    dir,
    { x: b.x, y: b.chest, z: b.z, radius: b.radius },
    range,
  );
  const body = bodyReaches(from, dir, b, b.radius + WAVE_HIT_RADIUS);
  if (body === null || body > range) return chest;
  return chest === null ? body : Math.min(chest, body);
}

/** Where a ray first meets a standing cylinder (its side or its top), as
 * a distance along it; null if it doesn't, or meets the floor first. */
function bodyReaches(
  from: Readonly<Vec3>,
  dir: Readonly<Vec3>,
  body: { x: number; z: number; top: number },
  radius: number,
): number | null {
  const ox = from[0] - body.x;
  const oz = from[2] - body.z;
  const top = body.top + WAVE_HIT_RADIUS;
  const c = ox * ox + oz * oz - radius * radius;
  // Already within it (pressed against it): hit as it leaves the hand, if
  // thrown at it at all, not away.
  if (c <= 0) {
    const toward = -(ox * dir[0] + oz * dir[2]) > 0;
    return toward && from[1] <= top ? 0 : null;
  }
  const a = dir[0] * dir[0] + dir[2] * dir[2];
  if (a > 1e-9) {
    const half = ox * dir[0] + oz * dir[2];
    const disc = half * half - a * c;
    if (disc >= 0) {
      const t = (-half - Math.sqrt(disc)) / a;
      if (t >= 0) {
        const y = from[1] + dir[1] * t;
        if (y < 0) return null;
        if (y <= top) return t;
      }
    }
  }
  // Over its shoulder and down onto its top.
  if (dir[1] >= 0 || from[1] <= top) return null;
  const t = (top - from[1]) / dir[1];
  const x = ox + dir[0] * t;
  const z = oz + dir[2] * t;
  return x * x + z * z <= radius * radius ? t : null;
}
