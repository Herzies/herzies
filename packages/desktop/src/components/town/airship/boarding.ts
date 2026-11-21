import { nextDeparture, type ShipIndex, type SkyDock } from "@herzies/shared";
import * as THREE from "three";
import { groundY, type TownMap } from "../map";
import { mapById } from "../maps";
import { goToMap, townLive, townSave } from "../runtime";
import { inCombatUntil } from "../wilds/store";
import { berthOf } from "./berth";
import {
  BOARDED_AT,
  GANGWAY,
  onDeck,
  PLANK_HINGE,
  PLANK_KEEP_HALF,
  PLANK_WALK_HALF,
  PLANK_WIDTH,
} from "./deck";
import { fleet } from "./fleet";
import { setAboardNear } from "./frames";
import {
  acrossPlank,
  alongPlank,
  onPlank,
  ontoPlank,
  type Plank,
  plankHeight,
  plankOf,
} from "./gangplank";
import { wildsService } from "./service";

/**
 * Getting on and off a sky ship: walked, freely. A moored ship's
 * gangplank is part of the island — walked up in the island's frame and
 * room, like the pier it comes down on — and the deck is the ship's. You
 * step aboard (into the ship's frame and room) as you come in through the
 * gangway, and ashore as you step back out of it onto the plank: on the
 * plank you're not aboard. Nothing walks you anywhere, but a gangplank
 * about to be drawn in sees whoever's on it down to the pier, and a ship
 * laid up sees its last passengers off.
 *
 * The two swaps are apart (ABOARD_X in, PLANK_HINGE.x out), so standing in
 * the gangway doesn't hop between rooms; and the island's server knows
 * the plank's there (TOWN_MAPS' `gangplank`), so neither server sees you
 * anywhere it wouldn't have you.
 */

/** Pace of a herzie being seen down a gangplank or across a deck (u/s). */
const SEEN_OFF_SPEED = 3.6;
/** Off the gangplank's foot, this far onto the pier (inland). */
const ASHORE = 1.4;

const v = new THREE.Vector3();
const inv = new THREE.Matrix4();

/** Which island a dock is on. */
export const dockOf = (map: TownMap): SkyDock | null =>
  map.id === "home" || map.id === "wilds" ? map.id : null;

/** The other end of the route. */
export const farEnd = (dock: SkyDock): SkyDock =>
  dock === "home" ? "wilds" : "home";

/** The ship tied up at `dock` right now, if any. */
export function shipAt(dock: SkyDock): ShipIndex | null {
  for (let k = 0; k < fleet.poses.length; k++) {
    const st = fleet.poses[k].state;
    if (st.kind === "docked" && st.at === dock) return k as ShipIndex;
  }
  return null;
}

/** Whether ship `ship` is laid up (tied up with nowhere to go till the next
 * service): its last passengers are seen off after a moment. */
export function laidUp(ship: ShipIndex): boolean {
  const st = fleet.poses[ship].state;
  return st.kind === "docked" && st.until === null;
}
/** How long you may stay aboard a laid-up ship before being seen off. */
export const LAID_UP_GRACE_MS = 6000;

/** Whether ship `ship`'s gangplank may be walked now: it's all the way
 * out. It starts coming in before a departure's counted down (see
 * route.ts's PLANK_IN_BY_S), and from then on it's shut — whoever's on it
 * is seen off. */
export function gangwayOpen(ship: ShipIndex): boolean {
  const p = fleet.poses[ship];
  return p.state.kind === "docked" && p.gangplank >= 0.999;
}

/** The ship lying at an island's dock, as walked from the island. */
export type Gangway = {
  plank: Plank;
  ship: ShipIndex;
  dock: SkyDock;
  /** Its plank may be walked. */
  open: boolean;
  /** And it's taking passengers (and you're not in a fight on the Wilds:
   * no sailing out of one): you may step aboard. */
  boarding: boolean;
};
const here: Gangway = {
  plank: null as unknown as Plank,
  ship: 0,
  dock: "home",
  open: false,
  boarding: false,
};

/** The ship at `map`'s dock now, with its plank (null: no dock, or no
 * ship there). The same object every call: read it, don't keep it. */
export function gangwayAt(map: TownMap): Gangway | null {
  const dock = dockOf(map);
  const plank = dock ? plankOf(map) : null;
  const ship = dock && plank ? shipAt(dock) : null;
  if (!dock || !plank || ship === null) return null;
  const st = fleet.poses[ship].state;
  here.plank = plank;
  here.ship = ship;
  here.dock = dock;
  here.open = gangwayOpen(ship);
  here.boarding =
    here.open &&
    st.kind === "docked" &&
    st.until !== null &&
    !(dock === "wilds" && performance.now() < inCombatUntil());
  return here;
}

/** On the Wilds with no way home: the ship's not at the dock (it's never
 * laid up there, so lying there it's taking passengers home), and won't
 * leave it again this service (or there's no service). It's the only way
 * off, so Systems sends you home. */
export function noShipHome(): boolean {
  if (shipAt("wilds") !== null) return false;
  return nextDeparture(wildsService(), "wilds", fleet.now) === null;
}
/** How long you're left on the Wilds with no ship home before you're sent
 * back to Town (ms): time to read why. */
export const STRANDED_GRACE_MS = 10_000;

/** How high to stand at (x, z) on `map`: the ground, or a moored ship's
 * gangplank over it (riding the ship's float at its top). */
export function standY(map: TownMap, x: number, z: number): number {
  const g = groundY(map, x, z);
  const w = gangwayAt(map);
  if (!w) return g;
  const p = w.plank;
  const along = alongPlank(p, x, z);
  if (along <= 0 || Math.abs(acrossPlank(p, x, z)) > PLANK_WIDTH / 2) return g;
  const top = fleet.poses[w.ship].y - map.origin[1] + PLANK_HINGE.y;
  return Math.max(g, plankHeight(p, along, top));
}

/**
 * An island step from (px, pz) to (x, z), kept to where a herzie may
 * stand: the island inside `reach`, and a moored ship's gangplank while
 * it's open — up into the gangway while the ship's boarding, to its top
 * otherwise. Someone already out on the plank as it closes stays on it
 * (going no further up) till they're seen off. Written into `out`.
 */
export function keepOnIsland(
  map: TownMap,
  reach: number,
  px: number,
  pz: number,
  x: number,
  z: number,
  out: { x: number; z: number },
): { x: number; z: number } {
  const w = gangwayAt(map);
  if (w) {
    const p = w.plank;
    const far = w.boarding ? p.aboard + 0.1 : p.length;
    if (w.open && onPlank(p, x, z, far)) return set(out, x, z);
    if (Math.hypot(x, z) > reach && Math.hypot(px, pz) > reach) {
      // Out on it already (a hair off its edge, as a step clamped there
      // comes back from the physics): kept on it, sliding along its side.
      const was = alongPlank(p, px, pz);
      if (onPlank(p, px, pz, p.aboard + 0.2, PLANK_KEEP_HALF))
        return ontoPlank(p, x, z, w.open ? far : Math.min(far, was), out);
    }
  }
  const r = Math.hypot(x, z);
  return r > reach
    ? set(out, (x / r) * reach, (z / r) * reach)
    : set(out, x, z);
}

/**
 * A step on deck from (px, pz) to (x, z) (deck-local), kept aboard: the
 * rail's colliders do the most of it, but the gangway's gap is shut here
 * — but for the plank's width, and only while it may be walked. Written
 * into `out`.
 */
export function keepOnDeck(
  ship: ShipIndex,
  px: number,
  pz: number,
  x: number,
  z: number,
  out: { x: number; z: number },
): { x: number; z: number } {
  if (onDeck(x, z)) return set(out, x, z);
  if (
    Math.abs(z - GANGWAY.z) <= PLANK_WALK_HALF &&
    x > GANGWAY.x - 0.6 &&
    gangwayOpen(ship)
  )
    return set(out, x, z);
  // Back inside the rail's line, or where it was.
  const cx = Math.min(x, GANGWAY.x - 0.01);
  return onDeck(cx, z) ? set(out, cx, z) : set(out, px, pz);
}

/** A herzie's way of going, carried across a swap (u/s, in the frame it's
 * going from). */
type Going = { vx: number; vz: number };

/** On an island, at (townSave.x, z) after a step: in through the gangway
 * of a ship taking passengers, step aboard. True if it did. */
export function crossAboard(map: TownMap, going: Going): boolean {
  const w = gangwayAt(map);
  if (!w?.boarding) return false;
  const p = w.plank;
  const { x, z } = townSave;
  if (alongPlank(p, x, z) < p.aboard) return false;
  if (Math.abs(acrossPlank(p, x, z)) > PLANK_KEEP_HALF) return false;
  stepAboard(w.ship, w.dock, going);
  return true;
}

/** Aboard ship `ship`, at (townSave.x, z) after a step: back out through
 * the gangway onto the plank, step ashore. True if it did. */
export function crossAshore(ship: ShipIndex, going: Going): boolean {
  const st = fleet.poses[ship].state;
  if (st.kind !== "docked" || !gangwayOpen(ship)) return false;
  if (townSave.x < PLANK_HINGE.x) return false;
  if (Math.abs(townSave.z - GANGWAY.z) > PLANK_KEEP_HALF) return false;
  stepAshore(ship, st.at, going);
  return true;
}

/** Into ship `ship`'s frame and room from where the herzie stands on the
 * gangway at `dock`: nothing about the world changes but the frame. */
function stepAboard(ship: ShipIndex, dock: SkyDock, going: Going): void {
  const map = mapById(dock);
  const [ox, oy, oz] = map.origin;
  inv.copy(fleet.matrices[ship]).invert();
  v.set(
    townSave.x + ox,
    standY(map, townSave.x, townSave.z) + oy,
    townSave.z + oz,
  ).applyMatrix4(inv);
  const yaw = fleet.poses[ship].yaw;
  // Drawn round this island still.
  setAboardNear(dock);
  townSave.ship = ship;
  goToMap(
    "airship",
    { x: v.x, z: v.z, heading: townSave.heading - yaw },
    { seamless: true, going: turned(going, -yaw) },
  );
}

/** Out of ship `ship`'s frame and room onto the gangplank at `dock`, from
 * where the herzie stands in the gangway. */
function stepAshore(ship: ShipIndex, dock: SkyDock, going: Going): void {
  const map = mapById(dock);
  const [ox, oy, oz] = map.origin;
  v.set(townSave.x, 0, townSave.z)
    .applyMatrix4(fleet.matrices[ship])
    .sub(new THREE.Vector3(ox, oy, oz));
  const yaw = fleet.poses[ship].yaw;
  goToMap(
    dock,
    { x: v.x, z: v.z, heading: townSave.heading + yaw },
    { seamless: true, going: turned(going, yaw) },
  );
}

/** A velocity turned by `yaw` about the vertical (three's rotateY: a
 * heading h becomes h + yaw). */
function turned(g: Going, yaw: number): Going {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { vx: g.vx * c + g.vz * s, vz: g.vz * c - g.vx * s };
}

const STILL: Going = { vx: 0, vz: 0 };

/** Where the pier takes someone seen off a gangplank at `dock`: a step
 * inland of its foot, facing inland. */
function ashoreAt(dock: SkyDock): { x: number; z: number; heading: number } {
  const b = berthOf(mapById(dock));
  if (!b) throw new Error(`airship: no dock on ${dock}`);
  return {
    x: b.pierEnd.x - Math.sin(b.out) * ASHORE,
    z: b.pierEnd.z - Math.cos(b.out) * ASHORE,
    heading: b.out + Math.PI,
  };
}

/** Walked down to the pier from wherever on the plank (island-local). */
function downToPier(dock: SkyDock): void {
  const to = ashoreAt(dock);
  townLive.seat = null;
  townLive.glide = {
    ...to,
    from: performance.now(),
    ms: Math.max(
      250,
      (Math.hypot(to.x - townSave.x, to.z - townSave.z) / SEEN_OFF_SPEED) *
        1000,
    ),
  };
}

/** On an island: anyone out on a gangplank that's closing (or whose ship
 * has gone) is seen down to the pier. Call once a frame. */
export function seeOffPlank(map: TownMap, reach: number): void {
  if (townLive.glide || Math.hypot(townSave.x, townSave.z) <= reach) return;
  const dock = dockOf(map);
  const p = dock ? plankOf(map) : null;
  if (
    !dock ||
    !p ||
    !onPlank(p, townSave.x, townSave.z, p.aboard + 0.2, PLANK_KEEP_HALF)
  )
    return;
  if (gangwayAt(map)?.open) return;
  downToPier(dock);
}

/** See the herzie off laid-up ship `ship`: across the deck to the gangway,
 * out through it (ashore) and down the plank to the pier. */
export function seeOffShip(ship: ShipIndex): void {
  const st = fleet.poses[ship].state;
  if (st.kind !== "docked") return;
  const dock = st.at;
  townLive.seat = null;
  const out = () => {
    const far = Math.hypot(PLANK_HINGE.x - townSave.x, townSave.z);
    townLive.glide = {
      x: PLANK_HINGE.x + 0.02,
      z: GANGWAY.z,
      // Facing out of the gangway: +x.
      heading: Math.PI / 2,
      from: performance.now(),
      ms: Math.max(250, (far / SEEN_OFF_SPEED) * 1000),
      after: () => {
        stepAshore(ship, dock, STILL);
        downToPier(dock);
      },
    };
  };
  // From well inside the rail: to the gangway first, so it isn't walked
  // through the rail (or a bench).
  const across = Math.abs(townSave.z - GANGWAY.z) > GANGWAY.halfWidth - 0.3;
  if (townSave.x < BOARDED_AT.x - 0.2 || across) {
    const far = Math.hypot(
      BOARDED_AT.x - townSave.x,
      BOARDED_AT.z - townSave.z,
    );
    townLive.glide = {
      x: BOARDED_AT.x,
      z: BOARDED_AT.z,
      heading: Math.PI / 2,
      from: performance.now(),
      ms: Math.min(3000, Math.max(300, (far / SEEN_OFF_SPEED) * 1000)),
      after: out,
    };
  } else out();
}

/** The ship's room wouldn't have us (it's full): back on the pier of the
 * island it's at (or the one it just left), facing inland. */
export function turnedAway(ship: ShipIndex): void {
  const st = fleet.poses[ship].state;
  const dock = st.kind === "docked" ? st.at : st.from;
  if (!berthOf(mapById(dock))) {
    goToMap("home");
    return;
  }
  goToMap(dock, ashoreAt(dock));
}

function set(
  out: { x: number; z: number },
  x: number,
  z: number,
): { x: number; z: number } {
  out.x = x;
  out.z = z;
  return out;
}
