/**
 * A sky ship's deck, in the ship's own frame: the walking surface is the
 * plane y = 0, the bow is +z, and +x is the side that lies against the
 * pier when it's moored (port). Herzies on board walk in this frame (the
 * `airship` map, which only says where the benches are); the ship's flight
 * moves the whole frame through the sky (see route.ts), so nothing on deck
 * ever needs to know the ship is moving.
 *
 * The model (AirshipModel) is built round these numbers, and the deck's
 * colliders come from them, so the rails you see are the rails you bump.
 */

/** The deck's outline at the inside face of its rail, port side (+x) from
 * the stern round to the bow's tip; the starboard side mirrors it. */
const PORT_OUTLINE: readonly [x: number, z: number][] = [
  [3.4, -11],
  [4.2, -8],
  [4.5, -4],
  [4.5, 3.5],
  [4.0, 6.6],
  [3.0, 9.0],
  [1.6, 10.9],
  [0, 11.8],
];

/** The whole outline: port side stern to bow, then starboard bow to
 * stern. Closed (the last point joins the first). */
export const DECK_OUTLINE: readonly [x: number, z: number][] = [
  ...PORT_OUTLINE,
  ...PORT_OUTLINE.slice(0, -1)
    .reverse()
    .map(([x, z]) => [-x, z] as [number, number]),
];

/** Stern to bow at the rail, and across at its widest. */
export const DECK_LENGTH = 22.8;
export const DECK_BEAM = 9;

/** How high the rail stands over the deck (herzies see over it), and how
 * thick it is (its colliders lie outside DECK_OUTLINE, this deep). */
export const RAIL_HEIGHT = 1.05;
export const RAIL_THICKNESS = 0.22;

/** Where the gangplank comes aboard: a gap in the port rail, midships.
 * Its middle is on the rail's line (x = GANGWAY.x); `halfWidth` either
 * side along z. While moored, the gangplank runs from here down to the
 * pier's end. */
export const GANGWAY = { x: 4.5, z: 0, halfWidth: 1.3 } as const;

/** Where the gangplank hinges: its top at the gangway's outer edge, a
 * hair under the deck. */
export const PLANK_HINGE = { x: GANGWAY.x + RAIL_THICKNESS, y: -0.02 };
export const PLANK_WIDTH = 2;
/** How far either side of the gangplank's middle a herzie's middle may
 * walk (its body is 0.55 round, between the handrails). */
export const PLANK_WALK_HALF = 0.5;
/** How far off it a herzie still counts as on the plank (or in the
 * gangway): a hair wider. A step pushed against its edge is clamped to
 * exactly PLANK_WALK_HALF, and the physics hands positions back in f32,
 * a few millionths either side; judged by the walkable half alone, half
 * of those would fall off the plank's side and be put back on the island's
 * rim (metres back, partway up). */
export const PLANK_KEEP_HALF = PLANK_WALK_HALF + 0.05;
/** The gangway's threshold, walked through (see boarding.ts): in from the
 * hinge past this x you're aboard (in the ship's room and frame); back
 * out past the hinge, ashore. Apart, so dithering in the gangway doesn't
 * hop between rooms. */
export const ABOARD_X = 4.2;

/** Just inside the gangway, looking across the deck: where a passenger
 * walked off a laid-up ship is taken first, clear of the benches. */
export const BOARDED_AT = { x: 2.9, z: 0, heading: -Math.PI / 2 } as const;

/** What stands on deck that you can't walk through, as circles (x, z,
 * radius): the helm at the stern and the bell post at the bow. The
 * benches are the `airship` map's own (`_`), with their own colliders. */
export const DECK_OBSTACLES: readonly { x: number; z: number; r: number }[] = [
  { x: 0, z: -9.2, r: 0.55 },
  { x: 0, z: 8.4, r: 0.35 },
];

/** The rail as straight runs (each with its two ends, x/z), leaving the
 * gangway open: what the colliders are built from. */
export function railRuns(): [x0: number, z0: number, x1: number, z1: number][] {
  const runs: [number, number, number, number][] = [];
  const pts = DECK_OUTLINE;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    // The port side's straight midships run, cut by the gangway.
    if (x0 === GANGWAY.x && x1 === GANGWAY.x) {
      const lo = Math.min(z0, z1);
      const hi = Math.max(z0, z1);
      runs.push([x0, lo, x0, GANGWAY.z - GANGWAY.halfWidth]);
      runs.push([x0, GANGWAY.z + GANGWAY.halfWidth, x0, hi]);
      continue;
    }
    runs.push([x0, z0, x1, z1]);
  }
  return runs;
}

/** Whether a deck point is inside the rail (the gangway's gap aside). */
export function onDeck(x: number, z: number): boolean {
  let inside = false;
  const pts = DECK_OUTLINE;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
