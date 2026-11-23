import { type ShipIndex, WILDS_LEG_MS } from "@herzies/shared";
import type { ShadowFocus } from "../DayLight";
import { islandRadius, type TownMap } from "../map";
import { berthOf } from "./berth";
import { fleet } from "./fleet";

/**
 * Where the sun's shadows fall when the sky ship's about. One shadow
 * map covers what you can see up close: on an island with a Sky Dock, the
 * island and the berth beside it together (so a ship lying there is
 * shadowed like everything else, and stepping aboard changes nothing);
 * aboard and under way, just the ship, crisply — eased between the two as
 * it leaves one island and comes in to the other.
 */

/** Round the ship: its length, and a little over. */
const SHIP_REACH = 14;
/** Past the island's rim, for roofs and treetops (as DayLight's own). */
const RIM = 4;
/** Over the first and last this many seconds of a leg, the box moves
 * between the island and the ship. */
const EASE_S = 6;

const smooth = (x: number) => {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * t * (t * (t * 6 - 15) + 10);
};

type Circle = { x: number; z: number; r: number };

/** The smallest circle holding both. */
function union(a: Circle, b: Circle): Circle {
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  if (d + b.r <= a.r) return a;
  if (d + a.r <= b.r) return b;
  const r = (d + a.r + b.r) / 2;
  const k = (r - a.r) / d;
  return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, r };
}

/** The shadow box for `view` (the island drawn at the origin), following
 * ship `aboard` if you're on one. */
export function shadowFocusFor(
  view: TownMap,
  aboard: ShipIndex | null,
): ShadowFocus {
  const island: Circle = { x: 0, z: 0, r: islandRadius(view) + RIM };
  const b = berthOf(view);
  const rest = b
    ? union(island, { x: b.ship.x, z: b.ship.z, r: SHIP_REACH })
    : island;
  const [ox, , oz] = view.origin;
  return (out) => {
    let w = 0;
    let sx = 0;
    let sz = 0;
    if (aboard !== null) {
      const p = fleet.poses[aboard];
      sx = p.x - ox;
      sz = p.z - oz;
      const st = p.state;
      if (st.kind === "flying") {
        const into = (fleet.now - st.departedAt) / 1000;
        w = Math.min(
          smooth(into / EASE_S),
          smooth((WILDS_LEG_MS / 1000 - into) / EASE_S),
        );
      }
    }
    out.x = rest.x + (sx - rest.x) * w;
    out.z = rest.z + (sz - rest.z) * w;
    out.reach = rest.r + (SHIP_REACH - rest.r) * w;
  };
}
