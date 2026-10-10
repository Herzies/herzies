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
  /** The player's herzie walks on two feet (stage 3) rather than hopping. */
  playerLegs: boolean;
  /** The player's herzie itself, for casting (see Combat). */
  playerHerzie: HerzieModel | null;
  /** The player's physics body, so aiming can look past it. */
  playerRigidBody: RapierRigidBody | null;
  /** The camera's azimuth (camera-controls' convention: 0 puts the camera
   * on the target's +z side). Movement is relative to it. */
  cameraAzimuth: number;
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
  teleport: null as { x: number; z: number } | null,
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
 * given), facing `heading`. The world swaps its island under you. */
export function goToMap(
  id: MapId,
  at?: { x: number; z: number; heading: number },
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
    // Behind the herzie, looking the way it faces.
    azimuth: to.heading - Math.PI,
  });
  townLive.seat = null;
  townLive.teleport = null;
  for (const l of mapListeners) l();
}

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
