import { useEffect, useSyncExternalStore } from "react";
import { notify } from "../../../lib/notices";
import { townNet } from "../net/townNet";
import { sfxStance } from "../sfx";
import { bossFight } from "./fight";
import { skills } from "./skills";
import { combat } from "./state";

/**
 * A Bard's lute has two stances: attacking (sonic waves at the boss) and
 * healing (bolts at the ally you aim at, no cooldown, the same pace). R
 * switches; the choice is remembered. The cave is told on every switch and
 * every arrival (as the music is, tune.ts), and tells everyone else, so
 * other Bards' bolts are drawn green.
 */

const KEY = "town.lute.stance";

export const stance = {
  /** You chose to heal (it only counts with a lute: see healing()). */
  heal: (() => {
    try {
      return localStorage.getItem(KEY) === "heal";
    } catch {
      return false;
    }
  })(),
  /** Others in their heal stance, by entity id. */
  healers: new Set<number>(),
  /** The ally your heal bolt is locked onto right now (an entity id), if
   * any: drawn under them (HealVFX), and where the next bolt goes. */
  lock: null as number | null,
};

const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** Whether your basic attack can heal: a Bard with its lute. */
export function canHeal(): boolean {
  return (
    combat.attack === "wave" && skills.armed && skills.instrument === "lute"
  );
}

/** Whether your basic attack heals right now. */
export function healing(): boolean {
  return stance.heal && canHeal();
}

/** R: attack ⇄ heal. */
export function toggleStance(): void {
  if (!canHeal()) {
    if (skills.instrument === "lute")
      notify('Equip "Lute" to heal with it.', { kind: "info" });
    return;
  }
  stance.heal = !stance.heal;
  try {
    localStorage.setItem(KEY, stance.heal ? "heal" : "attack");
  } catch {
    // Not remembered, then.
  }
  sfxStance(stance.heal);
  emit();
}

/** Someone else switched (or the room said who's healing on arrival). */
export function setHealer(id: number, heal: boolean): void {
  if (heal === stance.healers.has(id)) return;
  if (heal) stance.healers.add(id);
  else stance.healers.delete(id);
}

/** Out of the room: nobody's known to be healing. */
export function resetHealers(): void {
  stance.healers.clear();
  stance.lock = null;
}

/** Re-renders on a switch (the hotbar's stance button). */
export function useStance(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => healing(),
  );
}

/** A margin under the room's own limit (100 ms), for jitter. */
const SEND_EVERY_MS = 200;
let sent: { heal: boolean; room: string; at: number } | null = null;

/** Keeps a fight told of your stance: only the latest, on every change and
 * every arrival, never faster than the room takes them. */
export function useStanceSender() {
  useEffect(() => {
    const t = setInterval(() => {
      if (!bossFight.on || bossFight.you === null) {
        sent = null;
        return;
      }
      const room = `${bossFight.event}:${bossFight.you}`;
      const now = performance.now();
      const wanted = healing();
      if (sent?.room === room && sent.heal === wanted) return;
      if (sent?.room === room && now - sent.at < SEND_EVERY_MS) return;
      townNet().sendStance(wanted);
      sent = { heal: wanted, room, at: now };
    }, 100);
    return () => clearInterval(t);
  }, []);
}
