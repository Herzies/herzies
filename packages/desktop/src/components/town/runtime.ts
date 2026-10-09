import { createContext, type RefObject, useContext } from "react";
import type * as THREE from "three";
import type { Seat } from "./Benches";
import type { TownInput } from "./input";
import { parseMap, type TownMap } from "./map";
import homeMap from "./maps/home.json";

export { ISLAND_RADIUS, WORLD_RADIUS } from "./map";

/** The home island, as painted in the map editor (`pnpm map-editor`). */
export const HOME_MAP: TownMap = parseMap(homeMap);

/** Per-frame state the scene's parts share, outside React (they all read
 * and write it inside the frame loop, where re-rendering is no option). */
export type TownRuntime = {
  input: RefObject<TownInput>;
  /** The player's body, whose (interpolated) position the camera follows. */
  playerBody: THREE.Object3D | null;
  /** Ground speed the player actually moved at last step (after
   * collisions), for its walk cycle. */
  playerSpeed: number;
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
export const { spots: SPOTS, spare: SPARE_SPOTS } = spotsOf(HOME_MAP);

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
