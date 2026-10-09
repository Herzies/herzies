/**
 * The server's checks on what clients claim. Clients move their own herzies
 * (so walking feels instant), and the server only accepts moves a herzie
 * could really make. It doesn't re-run collisions: the Town is a social
 * space, so walking through a tree with a hacked client isn't worth a
 * physics engine on the server.
 */
import {
  TOWN_MAPS,
  TOWN_WALK_SPEED,
  type TownMapId,
} from "@herzies/shared/town-net";

/** How much faster than walking a herzie may seem to go. Packets arrive
 * bunched up, so some slack is needed on top of the real top speed. */
const SPEED_SLACK = 1.5;
/** Distance a herzie may build up while its packets are delayed. */
const MAX_BUDGET = TOWN_WALK_SPEED * SPEED_SLACK * 2;
/** A jump onto the spawn point is a respawn, which is allowed. */
const SPAWN_TOLERANCE = 1.5;
/** Leeway past the walkable edge, for rounding on the wire. */
const EDGE_TOLERANCE = 0.5;

export type MoveGuard = {
  x: number;
  z: number;
  /** When the last accepted move arrived, ms. */
  at: number;
  /** Distance the herzie may still cover right now. */
  budget: number;
};

export function newGuard(x: number, z: number, now: number): MoveGuard {
  return { x, z, at: now, budget: MAX_BUDGET };
}

/** Whether a move to (x, z) at `now` is possible; updates the guard if so. */
export function checkMove(
  g: MoveGuard,
  x: number,
  z: number,
  now: number,
  map: TownMapId,
): boolean {
  const { radius, spawn } = TOWN_MAPS[map];
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  if (Math.hypot(x, z) > radius + EDGE_TOLERANCE) return false;
  const elapsed = Math.max(0, now - g.at) / 1000;
  const budget = Math.min(
    MAX_BUDGET,
    g.budget + elapsed * TOWN_WALK_SPEED * SPEED_SLACK,
  );
  const distance = Math.hypot(x - g.x, z - g.z);
  const respawn = Math.hypot(x - spawn.x, z - spawn.z) <= SPAWN_TOLERANCE;
  if (distance > budget && !respawn) return false;
  g.x = x;
  g.z = z;
  g.at = now;
  g.budget = respawn && distance > budget ? MAX_BUDGET : budget - distance;
  return true;
}

/** Where a newcomer may start: where they say, if it's on the island. */
export function startingPoint(
  map: TownMapId,
  x: unknown,
  z: unknown,
): { x: number; z: number } {
  const { radius, spawn } = TOWN_MAPS[map];
  if (
    typeof x === "number" &&
    typeof z === "number" &&
    Number.isFinite(x) &&
    Number.isFinite(z) &&
    Math.hypot(x, z) <= radius
  )
    return { x, z };
  return { ...spawn };
}

/** A token bucket: `rate` messages a second, bursts up to `burst`. */
export class RateLimiter {
  private tokens: number;
  private at: number;
  constructor(
    private rate: number,
    private burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.at = now;
  }

  take(now: number): boolean {
    this.tokens = Math.min(
      this.burst,
      this.tokens + ((now - this.at) / 1000) * this.rate,
    );
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
