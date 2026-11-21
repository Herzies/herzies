import { type ShipIndex, SKY_SHIPS, type SkyDock } from "@herzies/shared";
import { useSyncExternalStore } from "react";
import type * as THREE from "three";

/**
 * The sky ship's deck as a place in the scene: the group (drawn by
 * SkyShips) whose matrix carries deck-local coordinates to the scene's,
 * this frame. What stands on a deck — the player's herzie while aboard,
 * everyone else aboard, the benches — is drawn inside it, in the deck's
 * own coordinates, so it rides with the ship exactly.
 */

const frames: (THREE.Group | null)[] = Array.from(
  { length: SKY_SHIPS },
  () => null,
);
const listeners = new Set<() => void>();

export function setShipFrame(ship: ShipIndex, group: THREE.Group | null): void {
  if (frames[ship] === group) return;
  frames[ship] = group;
  for (const l of listeners) l();
}

export function shipFrame(ship: ShipIndex): THREE.Group | null {
  return frames[ship];
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Ship `ship`'s deck group (null: no ship, or not drawn yet). */
export function useShipFrame(ship: ShipIndex | null): THREE.Group | null {
  return useSyncExternalStore(subscribe, () =>
    ship === null ? null : frames[ship],
  );
}

/** Which island the ship you're aboard is nearest (its world is drawn
 * round that one; see TownCanvas), re-rendering when it changes. */
let near: SkyDock = "home";
const nearListeners = new Set<() => void>();

export function setAboardNear(dock: SkyDock): void {
  if (dock === near) return;
  near = dock;
  for (const l of nearListeners) l();
}

export function aboardNear(): SkyDock {
  return near;
}

export function useAboardNear(): SkyDock {
  return useSyncExternalStore(
    (l) => {
      nearListeners.add(l);
      return () => nearListeners.delete(l);
    },
    () => near,
  );
}
