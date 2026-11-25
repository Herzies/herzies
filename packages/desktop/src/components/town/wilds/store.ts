import type { ServerMessage, WildsPvpState } from "@herzies/shared/town-net";
import { WILDS_PVP, wildsCanHurt } from "@herzies/shared/wilds-pvp";
import { useSyncExternalStore } from "react";

/**
 * The Wilds' free-for-all as the client holds it: everyone's PvP standing
 * as the room last said (health, down, protected), who you can hit, your
 * own health and whether you're in combat (no boarding a ship home). Written by
 * {@link handleWildsMessage} from the socket; read by the frame loop and,
 * through the hooks, by the HUD. The server judges every blow (see shared
 * wilds-pvp.ts): nothing here rolls damage.
 *
 * Framework-free apart from the hooks, and free of sound and sight: what
 * the player should feel goes out as a {@link WildsEvent} (see feel.ts).
 */

/** A herzie's standing, with its times on this machine's clock
 * (performance.now() ms). */
export type WildsStanding = {
  hp: number;
  maxHp: number;
  /** Down until (gets up in the camp then). */
  down: number | null;
  /** Hits on it don't count until then. */
  shield: number | null;
  /** Stunned until. */
  stun: number | null;
  /** Held by a Cymbal Trap until: it can't walk, but may still turn,
   * attack and use skills. */
  root: number | null;
  /** Last hurt (its bar shows for a while after). */
  hurtAt: number;
};

/** What happened, for the player to feel (numbers, sounds, lines). */
export type WildsEvent =
  | {
      k: "hp";
      id: number;
      hp: number;
      was: number;
      maxHp: number;
      /** Who hurt it, if that's what it was. */
      by: number | null;
    }
  | {
      k: "hit";
      target: number;
      damage: number;
      crit: boolean;
      blocked: boolean;
      /** A Forbidden Frequency bleed hit. */
      bleed: boolean;
    }
  | { k: "stun"; id: number; until: number }
  | { k: "down"; id: number }
  | { k: "up"; id: number }
  /** A herzie taken down: `won`, by you. */
  | { k: "feed"; text: string; won: boolean };

/** What the store needs from the connection. */
export type WildsContext = {
  /** A server time as performance.now() ms. */
  toLocal: (serverTime: number) => number;
  /** The map the welcome is for. */
  map: () => string;
};

export const wilds = {
  /** In a Wilds room: your entity id there (null elsewhere). */
  you: null as number | null,
  /** By entity id: everyone the room told of. */
  standing: new Map<number, WildsStanding>(),
  /** When you last took PvP damage: in combat a while after (no boarding
   * a sky ship home). */
  hurtMeAt: Number.NEGATIVE_INFINITY,
  /** Who took you down last, by name. */
  downBy: null as string | null,
};

// --- Change -----------------------------------------------------------------

let version = 0;
const listeners = new Set<() => void>();
const eventListeners = new Set<(e: WildsEvent) => void>();

function emit() {
  version++;
  for (const l of listeners) l();
}

function fire(e: WildsEvent) {
  for (const l of eventListeners) l(e);
}

/** Hears every {@link WildsEvent}. Returns the unsubscribe. */
export function onWildsEvent(fn: (e: WildsEvent) => void): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Re-renders when anything about the free-for-all changes. */
export function useWilds(): number {
  return useSyncExternalStore(subscribe, () => version);
}

// --- Reading ----------------------------------------------------------------

/** You're in a Wilds room: casts and skills go to the server. */
export function wildsOn(): boolean {
  return wilds.you !== null;
}

/** Whether herzie `id` is down. */
export function wildsDown(id: number | null): boolean {
  if (id === null) return false;
  return (wilds.standing.get(id)?.down ?? null) !== null;
}

/** Whether you're down. */
export function myWildsDown(): boolean {
  return wildsDown(wilds.you);
}

/** Your herzie is held where it stands: down, or stunned. Nothing goes off
 * either (see {@link wildsRooted} for a hold that only stops your feet). */
export function wildsHeld(now = performance.now()): boolean {
  if (wilds.you === null) return false;
  const s = wilds.standing.get(wilds.you);
  return !!s && (s.down !== null || (s.stun !== null && now < s.stun));
}

/** Your herzie is held where it stands by a Cymbal Trap: it can't walk
 * (or jump), but turns, attacks and uses skills as ever. */
export function wildsRooted(now = performance.now()): boolean {
  if (wilds.you === null) return false;
  const root = wilds.standing.get(wilds.you)?.root ?? null;
  return root !== null && now < root;
}

/**
 * Whether you may hit herzie `id` standing at (x, z), as the server will
 * judge it: you're both out of the camp, it's up and no longer protected,
 * and you're up. Where you stand is `me`.
 */
export function wildsFoe(
  id: number,
  at: { x: number; z: number },
  me: { x: number; z: number },
  now = performance.now(),
): boolean {
  if (wilds.you === null || id === wilds.you || myWildsDown()) return false;
  const s = wilds.standing.get(id);
  if (s && (s.down !== null || (s.shield !== null && now < s.shield)))
    return false;
  return wildsCanHurt(me, at);
}

/** Herzie `id`'s health bar, if it's shown: once it's hurt, or was in a
 * fight lately. */
export function wildsBarOf(
  id: number,
  now = performance.now(),
): { hp: number; maxHp: number } | undefined {
  const s = wilds.standing.get(id);
  if (!s || s.down !== null) return undefined;
  return s.hp < s.maxHp || now - s.hurtAt < WILDS_PVP.combatMs ? s : undefined;
}

let myHpShown: { hp: number; maxHp: number } | null = null;
/** Your PvP health in the Wilds: what your own health bar shows there in
 * place of your health. Null elsewhere. The same object while it's
 * unchanged (useSyncExternalStore compares it). */
export function myWildsHp(): { hp: number; maxHp: number } | null {
  const s = wilds.you === null ? undefined : wilds.standing.get(wilds.you);
  if (!s) myHpShown = null;
  else if (myHpShown?.hp !== s.hp || myHpShown.maxHp !== s.maxHp)
    myHpShown = { hp: s.hp, maxHp: s.maxHp };
  return myHpShown;
}

/** {@link myWildsHp}, re-rendering when it changes. */
export function useMyWildsHp(): { hp: number; maxHp: number } | null {
  return useSyncExternalStore(subscribe, myWildsHp);
}

/** Until when (performance.now() ms) you're in combat on the Wilds, and
 * may not step aboard a sky ship (no sailing out of a fight):
 * WILDS_PVP.combatMs after you last took PvP damage. Past (or -∞): free. */
export function inCombatUntil(): number {
  return wildsOn()
    ? wilds.hurtMeAt + WILDS_PVP.combatMs
    : Number.NEGATIVE_INFINITY;
}

// --- Writing ----------------------------------------------------------------

/** The line for a herzie taken down, as `you` reads it. */
export function feedLine(
  m: Extract<ServerMessage, { t: "pvpFeed" }>,
  you: number | null,
): string {
  if (m.by !== null && m.by === you)
    return m.logged
      ? `Took down "${m.victimName}" (they left mid-fight)`
      : `Took down "${m.victimName}"`;
  if (m.victim === you) return `"${m.byName}" took you down`;
  return m.logged
    ? `"${m.byName}" took down "${m.victimName}" (they left mid-fight)`
    : `"${m.byName}" took down "${m.victimName}"`;
}

function standingOf(
  m: WildsPvpState,
  ctx: WildsContext,
  was: WildsStanding | undefined,
): WildsStanding {
  return {
    hp: m.hp,
    maxHp: m.maxHp,
    down: m.down !== undefined ? ctx.toLocal(m.down) : null,
    shield: m.shield !== undefined ? ctx.toLocal(m.shield) : null,
    stun: was?.stun ?? null,
    root: was?.root ?? null,
    hurtAt: was?.hurtAt ?? Number.NEGATIVE_INFINITY,
  };
}

/** Apply one server message. Returns whether it was the free-for-all's
 * alone (the welcome and leaves are also everyone else's). */
export function handleWildsMessage(
  m: ServerMessage,
  ctx: WildsContext,
): boolean {
  const now = performance.now();
  switch (m.t) {
    case "welcome":
      resetWilds();
      wilds.you = ctx.map() === "wilds" ? m.you : null;
      emit();
      return false;
    case "leave":
      if (wilds.standing.delete(m.id)) emit();
      return false;
    case "pvp": {
      if (wilds.you === null) return true;
      const was = wilds.standing.get(m.id);
      const next = standingOf(m, ctx, was);
      const before = was?.hp ?? m.maxHp;
      const fell = next.down !== null && was?.down == null;
      const up = next.down === null && was?.down != null;
      if (m.hp < before) {
        next.hurtAt = now;
        if (m.id === wilds.you) wilds.hurtMeAt = now;
      }
      if (up) {
        // Up in the camp: not stunned nor held, its last fight over (as
        // the server has it), and that isn't a heal to show.
        next.stun = null;
        next.root = null;
        next.hurtAt = Number.NEGATIVE_INFINITY;
        if (m.id === wilds.you) wilds.hurtMeAt = Number.NEGATIVE_INFINITY;
      } else if (m.hp !== before)
        fire({
          k: "hp",
          id: m.id,
          hp: m.hp,
          was: before,
          maxHp: m.maxHp,
          by: m.by ?? null,
        });
      wilds.standing.set(m.id, next);
      if (fell) fire({ k: "down", id: m.id });
      if (up) fire({ k: "up", id: m.id });
      emit();
      return true;
    }
    case "pvpHit":
      fire({
        k: "hit",
        target: m.target,
        damage: m.damage,
        crit: m.crit,
        blocked: !!m.blocked,
        bleed: !!m.bleed,
      });
      return true;
    case "pvpStun": {
      const until = ctx.toLocal(m.until);
      const s = wilds.standing.get(m.id);
      if (s) s.stun = until;
      fire({ k: "stun", id: m.id, until });
      emit();
      return true;
    }
    case "trap": {
      // A Cymbal Trap's hold on a herzie. Also everyone's (the cymbal's
      // show, its sound: fight.ts), so not the free-for-all's alone.
      const s = m.mob ? undefined : wilds.standing.get(m.target);
      if (s) {
        s.root = ctx.toLocal(m.until);
        emit();
      }
      return false;
    }
    case "pvpFeed": {
      if (m.victim === wilds.you) wilds.downBy = m.byName;
      fire({
        k: "feed",
        text: feedLine(m, wilds.you),
        won: m.by !== null && m.by === wilds.you,
      });
      return true;
    }
    default:
      return false;
  }
}

/** Out of the room (another island, the Town closed): nothing of its
 * fights comes along. */
export function resetWilds(): void {
  wilds.you = null;
  wilds.standing.clear();
  wilds.hurtMeAt = Number.NEGATIVE_INFINITY;
  wilds.downBy = null;
  myHpShown = null;
  emit();
}
