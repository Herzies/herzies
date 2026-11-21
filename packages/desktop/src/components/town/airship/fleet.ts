import { type ShipIndex, SKY_SHIPS } from "@herzies/shared";
import * as THREE from "three";
import { islandRadius, type TownMap } from "../map";
import { mapById, TOWN_MAPS_LOCAL } from "../maps";
import { berthOf } from "./berth";
import {
  buildRoute,
  emptyPose,
  type Route,
  type ShipPose,
  type SkyBerth,
  shipPose,
} from "./route";
import { wildsService } from "./service";
import { skyNow } from "./skyClock";

/**
 * The sky ship (the fleet's just Blåmann), every frame: where it is in the
 * sky, worked out once at the top of the frame (FleetClock) so the ship,
 * everyone on its deck and the camera all see the same moment.
 */

/** A dock's berth in the sky (its island's frame moved by its origin). */
export function skyBerth(map: TownMap): SkyBerth | null {
  const b = berthOf(map);
  if (!b) return null;
  const [ox, oy, oz] = map.origin;
  return {
    x: ox + b.ship.x,
    y: oy + b.ship.y,
    z: oz + b.ship.z,
    yaw: b.ship.yaw,
  };
}

let cache: { home: TownMap; wilds: TownMap; route: Route } | null = null;

/** How far out from an island's middle a ship's path keeps, past its
 * rock: from the two it docks at, the hull's half-beam (a berth lies just
 * beyond, the ship broadside to the rim); from any other it passes, its
 * whole half-length and some (it may swing past bow or stern first, at
 * the island's height, through its treetops). */
const KEEP_OUT = 5;
const PASS_WIDE = 16;

/** The route between the home island's and the Wilds' docks (baked once
 * per pair of maps; the map editor's preview passes its own). */
export function routeOf(
  home: TownMap = mapById("home"),
  wilds: TownMap = mapById("wilds"),
): Route {
  if (cache && cache.home === home && cache.wilds === wilds) return cache.route;
  const a = skyBerth(home);
  const b = skyBerth(wilds);
  if (!a || !b) throw new Error("airship: home and the Wilds each need a dock");
  // Every island in the sky (not the rooms, nor the decks): the docks'
  // two, and any other a way between them might pass.
  const islands = [home, wilds, ...TOWN_MAPS_LOCAL.values()].filter(
    (m, i, all) =>
      !m.room && !m.ship && all.findIndex((n) => n.id === m.id) === i,
  );
  const avoid = islands.map((m) => ({
    x: m.origin[0],
    z: m.origin[2],
    r:
      islandRadius(m) +
      (m.id === home.id || m.id === wilds.id ? KEEP_OUT : PASS_WIDE),
  }));
  const route = buildRoute(a, b, avoid);
  cache = { home, wilds, route };
  return route;
}

/** Whether both docks are on the maps (the map editor may have none). */
export function hasRoute(): boolean {
  return !!berthOf(mapById("home")) && !!berthOf(mapById("wilds"));
}

/** The island a dock is on. */
export function dockMap(dock: "home" | "wilds"): TownMap {
  return mapById(dock);
}

const euler = new THREE.Euler(0, 0, 0, "YXZ");

/** A pose as a sky-frame matrix: deck-local to sky. */
export function poseMatrix(p: ShipPose, out: THREE.Matrix4): THREE.Matrix4 {
  euler.set(-p.pitch, p.yaw, p.roll, "YXZ");
  const q = quat.setFromEuler(euler);
  return out.compose(pos.set(p.x, p.y, p.z), q, ONE);
}
const quat = new THREE.Quaternion();
const pos = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

/** This frame's ships. */
export const fleet = {
  /** Server time this frame was worked out for (ms). */
  now: 0,
  poses: Array.from({ length: SKY_SHIPS }, emptyPose) as ShipPose[],
  /** Deck-local → sky, per ship. */
  matrices: Array.from({ length: SKY_SHIPS }, () => new THREE.Matrix4()),
  /** The heading each had last frame, for how far it turned since. */
  lastYaw: new Float64Array(SKY_SHIPS),
  /** How far each turned since last frame (rad). */
  turned: new Float64Array(SKY_SHIPS),
};

/** Work out the fleet for now (once a frame, before anything reads it). */
export function updateFleet(now = skyNow()): void {
  if (!hasRoute()) return;
  const route = routeOf();
  const service = wildsService();
  fleet.now = now;
  for (let k = 0; k < SKY_SHIPS; k++) {
    const p = shipPose(route, service, k as ShipIndex, now, fleet.poses[k]);
    poseMatrix(p, fleet.matrices[k]);
    const d = p.yaw - fleet.lastYaw[k];
    fleet.turned[k] = Math.atan2(Math.sin(d), Math.cos(d));
    fleet.lastYaw[k] = p.yaw;
  }
}
