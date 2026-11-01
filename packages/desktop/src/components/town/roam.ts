/**
 * A resident who doesn't stand still: they wander a little patch round their
 * spot, pausing between strolls, and now and then stop for a dance (Pip has
 * his headphones on). When you come up to talk they stop walking and turn to
 * you; a dance goes on. The pure part (no scene, no React), so it's tested on
 * its own; Visitor drives a herzie with it.
 */

import { WALK_SPEED } from "@herzies/shared/gl";
import {
  cellAt,
  groundY,
  inland,
  isSunk,
  objectAt,
  type TownMap,
  terrainAt,
} from "./map";

export type Vec2 = { x: number; z: number };

/** Every number in one place, so the feel can be tuned without hunting. */
export const ROAM = {
  /** How far from their spot they'll go. */
  radius: 4,
  /** The shortest stroll worth taking. */
  minStep: 1.5,
  /** Walking pace: a relaxed walk. The hop cycle runs on distance (STRIDE),
   * so much slower than this reads as slow motion. */
  speed: WALK_SPEED * 0.7,
  /** Standing about between strolls (s). */
  pause: [1.5, 4.5] as const,
  /** A dance, when they break into one (s). */
  dance: [5, 11] as const,
  /** How often a stop turns into a dance. */
  danceChance: 0.4,
  /** You're this close: they stop walking to talk. */
  talkRange: 4,
  /** Close enough to where they were going. */
  arrive: 0.08,
} as const;

/** Who roams (by card type), and how far from their spot. */
export const ROAMERS: Readonly<Record<string, { radius: number }>> = {
  pip: { radius: ROAM.radius },
};

export type RoamState = {
  /** Where they stand now. */
  at: Vec2;
  /** Where they're walking to, or null when stopped. */
  to: Vec2 | null;
  /** Seconds left of this pause or dance. */
  wait: number;
  dancing: boolean;
};

export function startRoam(home: Vec2, random = Math.random): RoamState {
  return {
    at: { ...home },
    to: null,
    wait: between(ROAM.pause, random),
    dancing: false,
  };
}

/**
 * One frame. `home` is their spot, `player` where you are, `ok` whether a
 * point is somewhere they can stand. Returns how fast they're moving (for
 * the walk), and mutates `s`.
 */
export function stepRoam(
  s: RoamState,
  opts: {
    home: Vec2;
    radius: number;
    player: Vec2;
    ok: (x: number, z: number) => boolean;
    dt: number;
    random?: () => number;
  },
): number {
  const { home, radius, player, ok, dt } = opts;
  const random = opts.random ?? Math.random;
  const near =
    Math.hypot(player.x - s.at.x, player.z - s.at.z) < ROAM.talkRange;

  // Someone to talk to: stop where they are (and pick up after).
  if (near && !s.dancing) {
    s.to = null;
    s.wait = Math.max(s.wait, between(ROAM.pause, random));
    return 0;
  }

  if (s.to) {
    const dx = s.to.x - s.at.x;
    const dz = s.to.z - s.at.z;
    const d = Math.hypot(dx, dz);
    const step = ROAM.speed * dt;
    if (d <= Math.max(step, ROAM.arrive)) {
      s.at = { ...s.to };
      s.to = null;
      arrived(s, random);
      return 0;
    }
    const nx = s.at.x + (dx / d) * step;
    const nz = s.at.z + (dz / d) * step;
    // Something in the way after all (the map changed under them): stop.
    if (!ok(nx, nz)) {
      s.to = null;
      arrived(s, random);
      return 0;
    }
    s.at = { x: nx, z: nz };
    return ROAM.speed;
  }

  s.wait -= dt;
  if (s.wait > 0) return 0;
  if (s.dancing) {
    // The song's over: a breather before the next stroll.
    s.dancing = false;
    s.wait = between(ROAM.pause, random);
    return 0;
  }
  if (near) return 0;
  s.to = pickTarget(s.at, home, radius, ok, random);
  // Nowhere to go: dance where they stand instead.
  if (!s.to) arrived(s, random);
  return 0;
}

/** Facing (atan2(dx, dz), as the herzies' heading) of where they're going,
 * or null when they're not walking. */
export function roamHeading(s: RoamState): number | null {
  if (!s.to) return null;
  return Math.atan2(s.to.x - s.at.x, s.to.z - s.at.z);
}

/** Somewhere in their patch they can walk straight to, or null. */
export function pickTarget(
  from: Vec2,
  home: Vec2,
  radius: number,
  ok: (x: number, z: number) => boolean,
  random: () => number = Math.random,
): Vec2 | null {
  for (let i = 0; i < 12; i++) {
    const a = random() * Math.PI * 2;
    const r = Math.sqrt(random()) * radius;
    const to = { x: home.x + Math.sin(a) * r, z: home.z + Math.cos(a) * r };
    const d = Math.hypot(to.x - from.x, to.z - from.z);
    if (d < ROAM.minStep) continue;
    if (clearPath(from, to, ok)) return to;
  }
  return null;
}

/** Every bit of the way from `a` to `b` is somewhere they can stand. */
export function clearPath(
  a: Vec2,
  b: Vec2,
  ok: (x: number, z: number) => boolean,
): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.25));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (!ok(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false;
  }
  return true;
}

function arrived(s: RoamState, random: () => number) {
  s.dancing = random() < ROAM.danceChance;
  s.wait = between(s.dancing ? ROAM.dance : ROAM.pause, random);
}

function between(
  [lo, hi]: readonly [number, number],
  random: () => number,
): number {
  return lo + random() * (hi - lo);
}

/** Grass and what's lying in it: nothing they'd bump into. */
const OPEN_GROUND = new Set([".", "v", "*", "m"]);
/** How wide they are, round the middle, for what's in the way. */
const BODY = 0.45;

/** Somewhere a roamer can stand: dry, open, on the island, and flat (no
 * stepping off a ledge). */
export function standable(map: TownMap, x: number, z: number): boolean {
  const y = groundY(map, x, z);
  for (const [dx, dz] of [
    [0, 0],
    [BODY, BODY],
    [BODY, -BODY],
    [-BODY, BODY],
    [-BODY, -BODY],
  ]) {
    const [col, row] = cellAt(map, x + dx, z + dz);
    if (!inland(map, col, row)) return false;
    if (isSunk(terrainAt(map, col, row))) return false;
    if (!OPEN_GROUND.has(objectAt(map, col, row))) return false;
    if (Math.abs(groundY(map, x + dx, z + dz) - y) > 0.2) return false;
  }
  return true;
}
