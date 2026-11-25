import type { ShipIndex } from "@herzies/shared";
import type { HerzieModel } from "@herzies/shared/gl";
import type { RapierRigidBody } from "@react-three/rapier";
import {
  createContext,
  type RefObject,
  useContext,
  useSyncExternalStore,
} from "react";
import type * as THREE from "three";
import type { Seat } from "./Benches";
import type { TownInput } from "./input";
import type { MapId, TownMap } from "./map";
import { HOME_MAP, mapById } from "./maps";

export { ISLAND_RADIUS, WORLD_RADIUS } from "./map";

export { HOME_MAP, mapById, TOWN_MAPS_LOCAL } from "./maps";

/** Per-frame state the scene's parts share, outside React (they all read
 * and write it inside the frame loop, where re-rendering is no option). */
export type TownRuntime = {
  input: RefObject<TownInput>;
  /** The player's body, whose (interpolated) position the camera follows. */
  playerBody: THREE.Object3D | null;
  /** Ground speed the player actually moved at last step (after
   * collisions), for its walk cycle. */
  playerSpeed: number;
  /** How far either side of its middle the player's feet come down (0:
   * it hops; see HerzieModel's footSpread). */
  playerFootSpread: number;
  /** The player's herzie itself, for casting (see Combat). */
  playerHerzie: HerzieModel | null;
  /** The player's physics body, so aiming can look past it. */
  playerRigidBody: RapierRigidBody | null;
  /** The camera's azimuth (camera-controls' convention: 0 puts the camera
   * on the target's +z side). Movement is relative to it. */
  cameraAzimuth: number;
  /** Whether a pet on foot (the cat spirit) can walk straight from one
   * point to another in the Town: nothing solid in the way, no water. Set by
   * the player (it has the physics world); remote players' cats ask it too. */
  petClear?: (ax: number, az: number, bx: number, bz: number) => boolean;
};

export const TownRuntimeContext = createContext<TownRuntime | null>(null);

export function useTownRuntime(): TownRuntime {
  const rt = useContext(TownRuntimeContext);
  if (!rt) throw new Error("useTownRuntime outside <TownCanvas>");
  return rt;
}

/** Where the player was and how the camera looked, kept across visits to a
 * visitor's screen (the world unmounts while one is open): coming back from
 * George's stall puts you back at his stall. */
export const townSave = {
  /** The island you're on. Home again each time the app starts. */
  map: HOME_MAP.id as MapId,
  x: HOME_MAP.spawn.at[0],
  z: HOME_MAP.spawn.at[1],
  /** Forward is (sin, cos) on the ground. */
  heading: HOME_MAP.spawn.heading,
  // Behind the player, looking the way it faces.
  azimuth: HOME_MAP.spawn.heading - Math.PI,
  polar: 1.2,
  /** Bumped on every arrival (another island, a respawn): the camera then
   * swings round behind the herzie, looking the way it faces. */
  arrival: 0,
  /** On a sky ship's deck (the `airship` map): which ship. */
  ship: 0 as ShipIndex,
};

/** What the player's herzie is doing right now, for the multiplayer Town
 * (which runs outside the frame loop and outlives the world's mounting). */
export const townLive = {
  /** Ground speed last physics step; 0 while the world isn't running. */
  speed: 0,
  /** When the player last pressed or held anything, performance.now() ms. */
  lastInputAt: 0,
  /** Set to move the herzie straight there next step (the server refused a
   * move); Player clears it. */
  teleport: null as { x: number; z: number; heading?: number } | null,
  /** Set to walk the herzie to (x, z) over `ms` (default GLIDE_MS),
   * turning to `heading` (a duel putting it on its mark, a ship seeing it
   * off; begun at `from`, performance.now() ms), on whatever it stands on
   * (a gangplank too). Player clears it on arrival, then calls `after`. */
  glide: null as {
    x: number;
    z: number;
    heading: number;
    from: number;
    ms?: number;
    after?: () => void;
  } | null,
  /** The bench seat the herzie is sitting on, if any (see Benches). */
  seat: null as Seat | null,
  /** Stand up from it next step (Player clears it). */
  standUp: false,
  /** The bench prompt was clicked: sit or stand, as E would (Systems
   * clears it). */
  benchPressed: false,
  /** Music is playing (the app's now-playing): the herzie dances when it
   * stands still. */
  music: false,
  /** It's dancing right now (Player sets it; sent to everyone else). */
  dancing: false,
  /** Going through a portal: the herzie can't be steered. */
  frozen: false,
  /** Jumps it has taken off on (Player sets it; the parity is sent to
   * everyone else, who play the same hop). */
  jumps: 0,
};

type Spot = { x: number; z: number };
const spot = ([x, z]: [number, number]): Spot => ({ x, z });

/** Where each visitor stands (x, z), from the map. Anyone else takes the
 * next spare spot. */
export function spotsOf(map: TownMap): {
  spots: Record<string, Spot>;
  spare: Spot[];
} {
  return {
    spots: Object.fromEntries(
      Object.entries(map.spots).map(([k, p]) => [k, spot(p)]),
    ),
    spare: map.spare.map(spot),
  };
}

/** How close you have to be to talk to someone… */
export const TALK_RANGE = 5;
/** …and for them to turn and look at you. */
export const NOTICE_RANGE = 8;
/** How close another herzie has to be for E to open its menu. */
export const HERZIE_REACH = 2.5;

/** A visitor's place in the world, and how they're doing. */
export type TownSpot = {
  key: string;
  card: import("../TownScene").EventCard;
  at: { x: number; z: number };
  /** In town and on their feet (a defeated boss isn't). */
  standing: boolean;
  /** "2d left", "in 4h", "HP 812 / 1000"… */
  status: string;
};

const mapListeners = new Set<() => void>();

/** Go to another island: you arrive at `at` (the map's spawn if not
 * given), facing `heading`. The world swaps its island under you.
 * `seamless`: stepping across without a cut (on or off a sky ship), so
 * the camera stays where it is rather than swinging round behind you, and
 * the herzie carries on as it was (see Player) — at `going`, its velocity
 * in the new frame. */
export function goToMap(
  id: MapId,
  at?: { x: number; z: number; heading: number },
  {
    seamless = false,
    going,
  }: { seamless?: boolean; going?: { vx: number; vz: number } } = {},
): void {
  const map = mapById(id);
  const to = at ?? {
    x: map.spawn.at[0],
    z: map.spawn.at[1],
    heading: map.spawn.heading,
  };
  Object.assign(townSave, {
    map: map.id,
    x: to.x,
    z: to.z,
    heading: to.heading,
  });
  if (!seamless) {
    // Behind the herzie, looking the way it faces.
    townSave.azimuth = to.heading - Math.PI;
    townSave.arrival++;
  }
  arriving.seamless = seamless;
  arriving.vx = seamless ? (going?.vx ?? 0) : 0;
  arriving.vz = seamless ? (going?.vz ?? 0) : 0;
  townLive.seat = null;
  townLive.teleport = null;
  townLive.glide = null;
  for (const l of mapListeners) l();
}

/** How the last goToMap went: seamlessly or not, and at what velocity
 * (Player reads it as it mounts, to carry its herzie over from the one
 * before). */
export const arriving = { seamless: false, vx: 0, vz: 0 };

/** The island you're on, re-rendering when you go to another. */
export function useTownMap(): TownMap {
  const id = useSyncExternalStore(
    (l) => {
      mapListeners.add(l);
      return () => mapListeners.delete(l);
    },
    () => townSave.map,
  );
  return mapById(id);
}
