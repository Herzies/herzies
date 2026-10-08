import { createContext, type RefObject, useContext } from "react";
import type * as THREE from "three";
import type { TownInput } from "./input";

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
  x: 0,
  z: 10,
  /** Forward is (sin, cos) on the ground; π faces the plaza from spawn. */
  heading: Math.PI,
  azimuth: 0,
  polar: 1.2,
  distance: 9,
};

/** Spots (x, z) where each visitor stands, around the plaza at the origin:
 * the boss up north, George to the west, Orphiez to the east, Nandor down
 * south-west. Anyone else takes the next spare spot. */
export const SPOTS: Record<string, { x: number; z: number }> = {
  boss_fight: { x: 0, z: -9 },
  merchant: { x: -8, z: -1 },
  song_hunt: { x: 8, z: -1 },
  treat_trader: { x: -5, z: 7 },
};
export const SPARE_SPOTS = [
  { x: 5, z: 7 },
  { x: 0, z: -15 },
];

/** How far you can walk from the middle of town. */
export const WORLD_RADIUS = 40;
/** How close you have to be to talk to someone… */
export const TALK_RANGE = 3.4;
/** …and for them to turn and look at you. */
export const NOTICE_RANGE = 7;

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
