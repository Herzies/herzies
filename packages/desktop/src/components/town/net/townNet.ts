import {
  isTownMapId,
  TOWN_FLAG_COMBAT,
  TOWN_FLAG_DANCING,
  TOWN_FLAG_JUMP,
  TOWN_FLAG_SITTING,
  type TownMapId,
  withCastSeq,
} from "@herzies/shared";
import { useEffect, useSyncExternalStore } from "react";
import { herzies } from "../../../tauri-bridge";
import { showToast } from "../cave";
import { setChampion } from "../champion";
import { bossFight, handleBossMessage } from "../combat/fight";
import { combat } from "../combat/state";
import { goToMap, townLive, townSave } from "../runtime";
import { setVitals } from "../vitals";
import { TownConnection, type TownTicket } from "./TownConnection";

/** Stay in the Town this long after leaving its tab or opening a visitor,
 * so popping out for a moment doesn't look like leaving to everyone else. */
const LINGER_MS = 90_000;
/** No input for this long shows the herzie as away. */
const AFK_MS = 2 * 60_000;

let ticketSource: (map: TownMapId) => Promise<TownTicket> = async (map) => {
  const t = await herzies.fetchTownTicket(map === "bossroom" ? map : undefined);
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
    onMessage: (m) =>
      handleBossMessage(m, {
        toLocal: (t) => net?.clock.toLocal(t) ?? t,
        you: () => net?.you ?? null,
      }),
    onRefused: (why) => {
      // The cave won't have us: back to town, with the reason.
      showToast(
        why === "down"
          ? "You need some rest first."
          : why === "full"
            ? "The lair is full right now. Try again in a moment."
            : "The lair is sealed right now.",
      );
      goToMap("home");
    },
    onRoomClosed: () => {
      showToast(
        bossFight.victory
          ? "The lair falls quiet. Back to town."
          : "The boss slipped away. Back to town.",
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
      townLive.teleport = { x, z };
    },
  });
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
    conn.start();
    conn.setAfk(false);
    const afk = setInterval(() => {
      conn.setAfk(performance.now() - townLive.lastInputAt > AFK_MS);
    }, 5_000);
    return () => {
      clearInterval(afk);
      townLive.speed = 0;
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

/** Re-renders when the connection's status or roster changes. */
export function useTownNetVersion(conn: TownConnection | null | undefined) {
  return useSyncExternalStore(conn?.subscribe ?? noopSubscribe, () =>
    conn ? conn.version : 0,
  );
}

const noopSubscribe = () => () => {};
