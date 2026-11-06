/**
 * The server's checks on what clients claim. Clients move their own herzies
 * (so walking feels instant), and the server only accepts moves a herzie
 * could really make. It doesn't re-run collisions: the Town is a social
 * space, so walking through a tree with a hacked client isn't worth a
 * physics engine on the server.
 */
import {
  TOWN_MAPS,
  TOWN_SPRINT_SPEED,
  TOWN_TICKETED_MAPS,
  type TownMapId,
} from "@herzies/shared/town-net";

/** How much faster than sprinting a herzie may seem to go. Packets arrive
 * bunched up, so some slack is needed on top of the real top speed. */
const SPEED_SLACK = 1.5;
/** Distance a herzie may build up while its packets are delayed. */
const MAX_BUDGET = TOWN_SPRINT_SPEED * SPEED_SLACK * 2;
/** A jump onto the spawn point is a respawn, which is allowed (in a fight,
 * only when the server sent the herzie there: allowSpawnJump). */
const SPAWN_TOLERANCE = 1.5;
/** How long after the server sends a herzie back to the start (the
 * Tower's next floor) the jump there may arrive: the client makes it half
 * a second after asking, at the portal's white-out, and the frames on the
 * way still have to land. */
export const SPAWN_JUMP_GRACE_MS = 5_000;
/** Leeway past the walkable edge, for rounding on the wire. */
const EDGE_TOLERANCE = 0.5;

export type MoveGuard = {
  x: number;
  z: number;
  /** When the last accepted move arrived, ms. */
  at: number;
  /** Distance the herzie may still cover right now. */
  budget: number;
  /** In a fight, until when (ms) one jump onto the spawn is allowed. */
  spawnUntil?: number;
};

export function newGuard(x: number, z: number, now: number): MoveGuard {
  return { x, z, at: now, budget: MAX_BUDGET };
}

/**
 * Whether a move to (x, z) at `now` is possible; updates the guard if so.
 *
 * A jump onto the map's spawn is a respawn, and passes however far it is.
 * In the fight rooms (the Tower, the boss's cave) only the game puts a
 * herzie back at the start, so there it passes only once the server has
 * said so (allowSpawnJump), and only once: otherwise a modified client
 * could leave any attack, from anywhere, by stepping onto the spawn.
 */
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
    g.budget + elapsed * TOWN_SPRINT_SPEED * SPEED_SLACK,
  );
  const distance = Math.hypot(x - g.x, z - g.z);
  const respawn =
    Math.hypot(x - spawn.x, z - spawn.z) <= SPAWN_TOLERANCE &&
    (!TOWN_TICKETED_MAPS.has(map) ||
      now <= (g.spawnUntil ?? Number.NEGATIVE_INFINITY));
  if (distance > budget && !respawn) return false;
  const jumped = respawn && distance > budget;
  g.x = x;
  g.z = z;
  g.at = now;
  g.budget = jumped ? MAX_BUDGET : budget - distance;
  if (jumped) g.spawnUntil = undefined;
  return true;
}

/** The server is sending this herzie back to the map's spawn (the Tower's
 * next floor): one jump there may follow, for a moment. */
export function allowSpawnJump(g: MoveGuard, now: number): void {
  g.spawnUntil = now + SPAWN_JUMP_GRACE_MS;
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
