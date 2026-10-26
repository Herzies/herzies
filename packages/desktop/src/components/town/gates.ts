import { BOSS_LOBBY_MS } from "@herzies/shared";
import { useEffect, useState, useSyncExternalStore } from "react";
import { caveOpen, useCave } from "./cave";
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
  if (isMouth(portal)) return caveOpen();
  if (portal.to === "tower") return towerOpen();
  // The way out of the cave is gone while the fight is on, for those in it:
  // no stepping out to rest. Out of it (or once it's over), it's back.
  const raid = bossFight.raid;
  if (raid && raid.stage === "fight" && raid.you === "in" && !bossFight.closing)
    return false;
  return true;
}

/** {@link portalOpen}, re-rendering when any of it changes. */
export function usePortalOpen(): (portal: Portal) => boolean {
  const cave = useCave();
  useTower();
  useBossFight();
  // The lobby opens on the clock, not on news: look again when it does.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (cave.kind !== "soon") return;
    const opens = cave.startsAt - BOSS_LOBBY_MS - Date.now();
    if (opens <= 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), opens + 50);
    return () => clearTimeout(t);
  }, [cave]);
  return portalOpen;
}
