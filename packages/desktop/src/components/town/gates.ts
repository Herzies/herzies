import { useSyncExternalStore } from "react";
import { getCave, useCave } from "./cave";
import { bossFight, useBossFight } from "./combat/fight";
import { mapById } from "./maps";
import type { Portal } from "./portal";

/**
 * Which portals are open right now. Some lead somewhere only while an event
 * is on: the boss's cave while the boss is up, the Tower while a Tower event
 * runs; and the Tower's way on only once its floor is cleared. A shut one
 * isn't drawn, walked through or offered.
 */

/** A Tower event is on, until `endsAt` (ms since the epoch); null: none. */
let tower: { endsAt: number } | null = null;
const listeners = new Set<() => void>();

export function setTowerOpen(next: { endsAt: number } | null): void {
  if ((next?.endsAt ?? null) === (tower?.endsAt ?? null)) return;
  tower = next;
  for (const l of listeners) l();
}

export function towerOpen(): boolean {
  return !!tower && tower.endsAt > Date.now();
}

function useTower() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => tower,
  );
}

/** A portal into a room (the boss's cave). */
export function isMouth(portal: Portal): boolean {
  return !portal.next && !!mapById(portal.to).room;
}

/** Whether `portal` is open, as things stand. */
export function portalOpen(portal: Portal): boolean {
  if (portal.next) return !!bossFight.tower?.cleared;
  if (isMouth(portal)) return getCave().kind === "open";
  if (portal.to === "tower") return towerOpen();
  return true;
}

/** {@link portalOpen}, re-rendering when any of it changes. */
export function usePortalOpen(): (portal: Portal) => boolean {
  useCave();
  useTower();
  useBossFight();
  return portalOpen;
}
