import { TUNE_MIN_INTERVAL_MS } from "@herzies/shared";
import { useEffect } from "react";
import { bossFight } from "./combat/fight";
import { townNet } from "./net/townNet";
import { wildsLoot } from "./wilds/loot";

/**
 * Tells the cave, the Tower or the Wilds whether you're playing music: the
 * boss hates it, any of it, the Tower pays the same, playing some is your
 * class's bonus, and on the Wilds it fills the Hunt Crystal. Only the
 * latest state is sent, no faster than the room takes them
 * (TUNE_MIN_INTERVAL_MS, with a margin), so play/pause mashing never trips
 * its rate limit; and it's sent again on every arrival in the room (a
 * reconnect starts the room's picture afresh).
 */

/** A margin over the room's own limit, for network jitter. */
const SEND_EVERY_MS = TUNE_MIN_INTERVAL_MS + 250;

let wanted = false;
let sent: { on: boolean; room: string; at: number } | null = null;

/** The room that cares whether you're playing, as a key that changes on
 * each arrival (a new entity id): a raid or the Tower, or the Wilds. Null:
 * none here does. */
function tunedRoom(): string | null {
  if (
    bossFight.on &&
    (bossFight.raid || bossFight.tower) &&
    bossFight.you !== null
  )
    return `${bossFight.event}:${bossFight.you}`;
  if (wildsLoot.you !== null) return `wilds:${wildsLoot.you}`;
  return null;
}

/** Keeps the cave, the Tower or the Wilds told whether music is playing
 * while you're in it. */
export function useTuneSender(playing: boolean) {
  wanted = playing;
  useEffect(() => {
    const t = setInterval(() => {
      const room = tunedRoom();
      if (room === null) {
        sent = null;
        return;
      }
      const now = performance.now();
      if (sent?.room === room && sent.on === wanted) return;
      if (sent?.room === room && now - sent.at < SEND_EVERY_MS) return;
      townNet().sendTune(wanted);
      sent = { on: wanted, room, at: now };
    }, 250);
    return () => clearInterval(t);
  }, []);
}
