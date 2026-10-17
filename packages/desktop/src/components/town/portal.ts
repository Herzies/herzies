import {
  cellCenter,
  facingAt,
  type MapId,
  objectAt,
  type TownMap,
} from "./map";
import { mapById } from "./maps";

/**
 * Portals: a swirling disc of light floating in the air, standing on one
 * island and leading to another. Walk through it (or press E beside it) and you're
 * there, stepping out of the portal on the far side that leads back.
 */

export type Portal = {
  key: string;
  x: number;
  z: number;
  /** Which way its front faces: forward is (sin, cos). */
  yaw: number;
  to: MapId;
  /** The Tower's way on to its next floor (on this same island). */
  next?: boolean;
};

/** How far you can be from a portal to step into it with E. */
export const PORTAL_REACH = 2.6;
/** The disc's half-width, and how close to its plane counts as through. */
export const PORTAL_HALF_WIDTH = 1.05;
/** Where you arrive: this far out in front of the portal on the far side. */
const STEP_OUT = 2.4;
/** A portal into a room (a cave's mouth) stands this far in front of its
 * cell's middle. The cave behind it is solid right up to its face, and a
 * herzie's body (0.55 across from its middle) can't get its middle to a
 * plane that close; so the plane stands out where it can be crossed. */
export const MOUTH_FORWARD = 0.5;

/** Every portal on the map: facing the way it was turned, else the middle
 * of the island. */
export function portalsOf(
  map: TownMap,
  /** Whether a map is a room (default: ask the maps there are). */
  isRoom: (id: MapId) => boolean = (id) => !!mapById(id).room,
): Portal[] {
  const out: Portal[] = [];
  for (let row = 0; row < map.size; row++) {
    for (let col = 0; col < map.size; col++) {
      if (objectAt(map, col, row) !== "O") continue;
      const key = `${col},${row}`;
      const link = map.portals?.[key];
      const to = link?.to;
      if (!to) continue;
      const [cx, cz] = cellCenter(map, col, row);
      const yaw = facingAt(map, col, row) ?? Math.atan2(-cx, -cz);
      const forward = isRoom(to) ? MOUTH_FORWARD : 0;
      out.push({
        key,
        x: cx + Math.sin(yaw) * forward,
        z: cz + Math.cos(yaw) * forward,
        yaw,
        to,
        ...(link.next ? { next: true } : {}),
      });
    }
  }
  return out;
}

/** Which side of a portal's disc a point is on (+ in front), and how far
 * along the disc from its middle. */
export function portalSide(p: Portal, x: number, z: number) {
  const fx = Math.sin(p.yaw);
  const fz = Math.cos(p.yaw);
  const dx = x - p.x;
  const dz = z - p.z;
  return { ahead: dx * fx + dz * fz, across: dx * fz - dz * fx };
}

/** Whether walking from (x0, z0) to (x1, z1) took you through the disc. */
export function walkedThrough(
  p: Portal,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): boolean {
  const a = portalSide(p, x0, z0);
  const b = portalSide(p, x1, z1);
  if (Math.sign(a.ahead) === Math.sign(b.ahead) || a.ahead === b.ahead) {
    return false;
  }
  // Where it crossed the plane, along the disc.
  const t = a.ahead / (a.ahead - b.ahead);
  const across = a.across + (b.across - a.across) * t;
  return Math.abs(across) < PORTAL_HALF_WIDTH;
}

/** Where you arrive on `to` coming from `from`: in front of the portal that
 * leads back, facing out of it — or the island's spawn if none does. */
export function arrivalOn(
  to: TownMap,
  from: MapId,
): { x: number; z: number; heading: number } {
  const back = portalsOf(to).find((p) => p.to === from);
  if (!back) {
    return { x: to.spawn.at[0], z: to.spawn.at[1], heading: to.spawn.heading };
  }
  return {
    x: back.x + Math.sin(back.yaw) * STEP_OUT,
    z: back.z + Math.cos(back.yaw) * STEP_OUT,
    heading: back.yaw,
  };
}

/**
 * Going through a portal: the view swirls and whites out while the herzie
 * spins down into the disc, the island swaps underneath, and it swirls
 * back in with the herzie stepping out on the far side. Driven by the
 * Town's Systems; Player, Post and the overlay read it.
 */
export const warp = {
  active: false,
  /** Seconds in. */
  t: 0,
  to: "" as MapId,
  /** The island has been swapped (half way). */
  swapped: false,
  /** Staying on this island (the Tower's next floor): back to its start
   * rather than a swap. */
  sameIsland: false,
};
/** Out (into the portal), then in (out of the far one), in seconds. */
export const WARP_OUT = 0.5;
export const WARP_IN = 0.55;

/** How far through the warp it is: 0 → 1 going out, back to 0 coming in. */
export function warpAmount(): number {
  if (!warp.active) return 0;
  if (warp.t < WARP_OUT) {
    const k = warp.t / WARP_OUT;
    return k * k;
  }
  const k = Math.min(1, (warp.t - WARP_OUT) / WARP_IN);
  return (1 - k) ** 2;
}

/** Into the portal to `to` (`sameIsland`: the Tower's next floor). */
export function startWarp(to: MapId, sameIsland = false): void {
  if (warp.active) return;
  Object.assign(warp, { active: true, t: 0, to, swapped: false, sameIsland });
}
