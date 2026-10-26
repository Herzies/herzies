import { TUNE_MIN_INTERVAL_MS } from "@herzies/shared";
import { useEffect } from "react";
import { bossFight } from "./combat/fight";
import { townNet } from "./net/townNet";

/**
 * Tells the cave whether you're playing music: the boss hates it, any of it,
 * and playing some is your class's bonus. Only the latest state is sent, no
 * faster than the room takes them (TUNE_MIN_INTERVAL_MS, with a margin), so
 * play/pause mashing never trips its rate limit; and it's sent again on
 * every arrival in the room (a reconnect starts the room's picture afresh).
 */

/** A margin over the room's own limit, for network jitter. */
const SEND_EVERY_MS = TUNE_MIN_INTERVAL_MS + 250;

let wanted = false;
let sent: { on: boolean; room: string; at: number } | null = null;

/** Keeps the cave told whether music is playing while you're in it. */
export function useTuneSender(playing: boolean) {
  wanted = playing;
  useEffect(() => {
    const t = setInterval(() => {
      if (!bossFight.on || !bossFight.raid || bossFight.you === null) {
        sent = null;
        return;
      }
      // Each arrival (a new entity id in a new fight) is a new room.
      const room = `${bossFight.event}:${bossFight.you}`;
      const now = performance.now();
      if (sent?.room === room && sent.on === wanted) return;
      if (sent?.room === room && now - sent.at < SEND_EVERY_MS) return;
      townNet().sendTune(wanted);
      sent = { on: wanted, room, at: now };
    }, 250);
    return () => clearInterval(t);
  }, []);
}
