import {
  isTownMapId,
  TOWN_FLAG_COMBAT,
  TOWN_FLAG_DANCING,
  TOWN_FLAG_JUMP,
  TOWN_FLAG_SITTING,
  TOWN_TICKETED_MAPS,
  type TownMapId,
  withCastSeq,
} from "@herzies/shared";
import { useEffect, useSyncExternalStore } from "react";
import { notify } from "../../../lib/notices";
import { herzies, onWindowHidden } from "../../../tauri-bridge";
import { turnedAway } from "../airship/boarding";
import { noteServerTime } from "../airship/skyClock";
import { setChampion } from "../champion";
import { MOB_DELAY_MS, setDrawDelaySource } from "../combat/drawDelay";
import { bossFight, handleBossMessage } from "../combat/fight";
import { combat } from "../combat/state";
import { forgetFighters } from "../duel/fx";
import {
  handleDuelMessage,
  inDuel,
  localOf,
  myDuel,
  resetDuels,
} from "../duel/store";
import { settleEat } from "../eat";
import { goToMap, townLive, townSave } from "../runtime";
import { setVitals } from "../vitals";
import { handleWildsLootMessage, resetWildsLoot } from "../wilds/loot";
import { handleWildsMessage, resetWilds } from "../wilds/store";
import { TownConnection, type TownTicket } from "./TownConnection";

/** Stay in the Town this long after leaving its tab or opening a visitor,
 * so popping out for a moment doesn't look like leaving to everyone else. */
const LINGER_MS = 90_000;
/** No input for this long shows the herzie as away. */
export const AFK_MS = 2 * 60_000;

let ticketSource: (map: TownMapId) => Promise<TownTicket> = async (map) => {
  const t = await herzies.fetchTownTicket(
    TOWN_TICKETED_MAPS.has(map) ? map : undefined,
  );
  // Every ticket carries the herzie's health as of now.
  if (t.vitals && !bossFight.on) setVitals(t.vitals);
  // And who the statue shows.
  setChampion(t.champion);
  return t;
};

/** Where tickets come from (the sandbox signs its own). Call before the
 * first {@link townNet}. */
export function setTownTicketSource(
  fn: (map: TownMapId) => Promise<TownTicket>,
) {
  ticketSource = fn;
}

let net: TownConnection | null = null;

/** The app's one connection to the multiplayer Town. */
export function townNet(): TownConnection {
  net ??= new TownConnection({
    map: isTownMapId(townSave.map) ? townSave.map : "home",
    getTicket: (map) => ticketSource(map),
    onMessage: (m) => {
      if (m.t === "ate") {
        settleEat(m);
        return;
      }
      const clock = {
        toLocal: (t: number) => net?.clock.toLocal(t) ?? t,
        you: () => net?.you ?? null,
      };
      // Duels have messages of their own; the welcome is everyone's.
      const duels = handleDuelMessage(m, {
        ...clock,
        who: (id) => {
          const r = net?.remotes.get(id);
          return r
            ? { name: r.name, seed: r.look.seed, title: r.title }
            : undefined;
        },
        send: (op) => net?.sendDuel(op),
      });
      // So does the Wilds' free-for-all.
      const pvp = handleWildsMessage(m, { ...clock, map: () => townSave.map });
      // And its loot: the cards dropped where herzies fell, the caches. A
      // cache's own loot is a `loot`, like a Tower mob's (the boss's below).
      const loot = handleWildsLootMessage(m, {
        ...clock,
        map: () => townSave.map,
        me: () => townSave,
      });
      if (!duels && !pvp && !loot) handleBossMessage(m, clock);
    },
    // Leaving mid-duel (another island, the Town closed) is yielding: said
    // now, rather than left to the room to find out.
    onLeaving: () => {
      if (inDuel()) net?.sendDuel({ op: "yield" });
      resetDuels();
      forgetFighters();
      resetWilds();
      resetWildsLoot();
    },
    onRefused: (why) => {
      // The sky ship's deck too crowded to come aboard: back down on the pier.
      if (townSave.map === "airship") {
        notify("Blåmann is full. Catch her next sailing!");
        turnedAway(townSave.ship);
        return;
      }
      // The cave (or the Tower) won't have us: back to town, with the
      // reason.
      const tower = townSave.map === "tower";
      notify(
        why === "down"
          ? "You need some rest first."
          : why === "locked"
            ? "You left this fight for good: the cave is closed to you until it's over."
            : tower
              ? "The Tower is closed right now."
              : why === "full"
                ? "The lair is full right now. Try again in a moment."
                : "The lair is sealed right now.",
      );
      goToMap("home");
    },
    onServerTime: (t) => noteServerTime(t),
    onRoomClosed: () => {
      notify(
        townSave.map === "tower"
          ? "The Tower closes for now. Back to town."
          : bossFight.victory
            ? "The lair falls quiet. Back to town."
            : bossFight.closing?.why === "wiped"
              ? "The boss won this time. Back to town."
              : "The boss slipped away. Back to town.",
        { kind: "info" },
      );
      goToMap("home");
    },
    readState: () => ({
      x: townSave.x,
      z: townSave.z,
      heading: townSave.heading,
      speed: townLive.speed,
      flags: withCastSeq(
        (townLive.seat ? TOWN_FLAG_SITTING : 0) |
          (townLive.dancing ? TOWN_FLAG_DANCING : 0) |
          (combat.on ? TOWN_FLAG_COMBAT : 0) |
          (townLive.jumps & 1 ? TOWN_FLAG_JUMP : 0),
        combat.casts,
      ),
    }),
    onCorrect: (x, z) => {
      // Put on your mark for a duel's countdown: walked there, facing the
      // ring's middle (and so the other one), not snapped.
      const d = myDuel();
      if (d && !townLive.frozen && performance.now() < localOf(d.startsAt)) {
        if (townLive.glide?.x !== x || townLive.glide.z !== z)
          townLive.glide = {
            x,
            z,
            heading: Math.atan2(d.x - x, d.z - z),
            from: performance.now(),
          };
        return;
      }
      townLive.teleport = { x, z };
    },
  });
  // Mobs and the boss are drawn on the same clock as everyone else.
  const clock = net.clock;
  setDrawDelaySource(() => (clock.synced ? clock.delay : MOB_DELAY_MS));
  return net;
}

let users = 0;
let linger: ReturnType<typeof setTimeout> | null = null;

/**
 * Be in the multiplayer Town while `active` (the Town is on screen). Leaving
 * marks the herzie away at once and disconnects after a grace period.
 */
export function useTownNet(active: boolean): TownConnection {
  const conn = townNet();
  useEffect(() => {
    if (!active) return;
    users++;
    if (linger) clearTimeout(linger);
    linger = null;
    townLive.lastInputAt = performance.now();
    // Minimised, covered or on another Space: the page is suspended, so a
    // live socket queues the room's messages for the wake. Drop it, rejoin
    // when the page is back.
    const onVisibility = () => {
      if (document.hidden) conn.stop();
      else {
        townLive.lastInputAt = performance.now();
        conn.start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) conn.start();
    conn.setAfk(false);
    const afk = setInterval(() => {
      conn.setAfk(performance.now() - townLive.lastInputAt > AFK_MS);
    }, 5_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(afk);
      townLive.speed = 0;
      // Closing the Town mid-duel is giving it up (the socket lingers, but
      // nobody's there to fight).
      if (inDuel()) conn.sendDuel({ op: "yield" });
      conn.setAfk(true);
      if (--users > 0) return;
      linger = setTimeout(() => {
        linger = null;
        conn.stop();
      }, LINGER_MS);
    };
  }, [active, conn]);
  return conn;
}

// Closed to the menu bar: leave the Town at once, not after the grace
// period. The page is suspended while hidden, so a socket left open queues
// everything the room says, and reopening would chew through all of it in
// one go (a freeze as long as the window was closed). Reopening restarts it.
onWindowHidden(() => {
  if (linger) clearTimeout(linger);
  linger = null;
  net?.stop();
});

/** Re-renders when the connection's status or roster changes. */
export function useTownNetVersion(conn: TownConnection | null | undefined) {
  return useSyncExternalStore(conn?.subscribe ?? noopSubscribe, () =>
    conn ? conn.version : 0,
  );
}

const noopSubscribe = () => () => {};
