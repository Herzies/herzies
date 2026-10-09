import { useEffect, useSyncExternalStore } from "react";
import { herzies } from "../../../tauri-bridge";
import { townLive, townSave } from "../runtime";
import { TownConnection, type TownTicket } from "./TownConnection";

/** Stay in the Town this long after leaving its tab or opening a visitor,
 * so popping out for a moment doesn't look like leaving to everyone else. */
const LINGER_MS = 90_000;
/** No input for this long shows the herzie as away. */
const AFK_MS = 2 * 60_000;

let ticketSource: () => Promise<TownTicket> = () => herzies.fetchTownTicket();

/** Where tickets come from (the sandbox signs its own). Call before the
 * first {@link townNet}. */
export function setTownTicketSource(fn: () => Promise<TownTicket>) {
  ticketSource = fn;
}

let net: TownConnection | null = null;

/** The app's one connection to the multiplayer Town. */
export function townNet(): TownConnection {
  net ??= new TownConnection({
    map: "home",
    getTicket: () => ticketSource(),
    readState: () => ({
      x: townSave.x,
      z: townSave.z,
      heading: townSave.heading,
      speed: townLive.speed,
      flags: 0,
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
