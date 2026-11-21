import type { TownMap } from "../map";
import { berthOf } from "./berth";
import { ABOARD_X, PLANK_HINGE, PLANK_WALK_HALF } from "./deck";

/**
 * A moored ship's gangplank as walked, island-local: a straight ramp from
 * the pier's end (its foot, on the ground) up to the gangway (its top, at
 * the deck), along the berth's `out`. The ship lies on that line, so the
 * deck's z = 0 runs down the plank's middle and its x grows down it.
 *
 * Pure geometry from the map: the ship that's there, and whether its
 * gangway's open, are boarding.ts's business.
 */

export type Plank = {
  /** Its foot: the pier's end, on the ground. */
  foot: { x: number; y: number; z: number };
  /** Up it, toward the ship: the unit (x, z) of the berth's `out`. */
  dx: number;
  dz: number;
  /** Foot to hinge, level (u). */
  length: number;
  /** Its top's height (over the island's grass), the ship lying exactly
   * at its berth: a moored ship's float moves it a few hundredths. */
  top: number;
  /** How far up it you're over the deck, past the gangway's threshold
   * (ABOARD_X): where you step aboard. */
  aboard: number;
};

const planks = new WeakMap<TownMap, Plank | null>();

/** The gangplank down to `map`'s Sky Dock, its ship at the berth; null if
 * the map has no dock. */
export function plankOf(map: TownMap): Plank | null {
  let p = planks.get(map);
  if (p !== undefined) return p;
  const b = berthOf(map);
  if (b) {
    const dx = Math.sin(b.out);
    const dz = Math.cos(b.out);
    // The hinge is PLANK_HINGE.x back from the ship's middle, toward the
    // pier (the gangway faces it).
    const hx = b.ship.x - dx * PLANK_HINGE.x;
    const hz = b.ship.z - dz * PLANK_HINGE.x;
    const length = (hx - b.pierEnd.x) * dx + (hz - b.pierEnd.z) * dz;
    p = {
      foot: { ...b.pierEnd },
      dx,
      dz,
      length,
      top: b.ship.y + PLANK_HINGE.y,
      aboard: length + (PLANK_HINGE.x - ABOARD_X),
    };
  } else p = null;
  planks.set(map, p);
  return p;
}

/** How far up the plank (x, z) is, from its foot. */
export function alongPlank(p: Plank, x: number, z: number): number {
  return (x - p.foot.x) * p.dx + (z - p.foot.z) * p.dz;
}

/** How far off the plank's middle line (x, z) is, either side. */
export function acrossPlank(p: Plank, x: number, z: number): number {
  return (x - p.foot.x) * p.dz - (z - p.foot.z) * p.dx;
}

/** Whether (x, z) is on the plank, from its foot up to `far` along it and
 * no further than `half` off its middle (by default, where you may walk). */
export function onPlank(
  p: Plank,
  x: number,
  z: number,
  far: number,
  half = PLANK_WALK_HALF,
): boolean {
  const a = alongPlank(p, x, z);
  return a >= 0 && a <= far && Math.abs(acrossPlank(p, x, z)) <= half;
}

/** (x, z) brought onto the plank, no further up it than `far`: written
 * into `out`. */
export function ontoPlank(
  p: Plank,
  x: number,
  z: number,
  far: number,
  out: { x: number; z: number },
): { x: number; z: number } {
  const a = Math.min(far, Math.max(0, alongPlank(p, x, z)));
  const c = Math.min(
    PLANK_WALK_HALF,
    Math.max(-PLANK_WALK_HALF, acrossPlank(p, x, z)),
  );
  out.x = p.foot.x + p.dx * a + p.dz * c;
  out.z = p.foot.z + p.dz * a - p.dx * c;
  return out;
}

/** The plank's surface `along` it, its top `top` high (level with the
 * deck past the hinge). */
export function plankHeight(p: Plank, along: number, top: number): number {
  const t = Math.min(1, Math.max(0, along / p.length));
  return p.foot.y + (top - p.foot.y) * t;
}
