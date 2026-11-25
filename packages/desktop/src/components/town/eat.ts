import {
  CONSUMABLE_COOLDOWN_MS,
  type EatRefusal,
  getItem,
  liveHp,
  type ServerMessage,
} from "@herzies/shared";
import { notify } from "../../lib/notices";
import { herzies } from "../../tauri-bridge";
import { pushHealNumber } from "./combat/DamageNumbers";
import { bossFight } from "./combat/fight";
import { pushLootLog } from "./combat/lootFeed";
import { townNet } from "./net/townNet";
import { townSave } from "./runtime";
import { getVitals, setVitals } from "./vitals";

/**
 * Eating a consumable (a Star Candy): from a Town hotbar slot or the bank's
 * menu. Two ways in, depending on who holds the herzie's HP:
 *  - in the boss room, the room's fight: it uses the candy up and heals,
 *    and the HP comes back as an `hp` message like any heal. Decided by the
 *    map, not by whether the fight has said hello yet: a heal written to the
 *    database while the fight holds your HP would be overwritten by its next
 *    report. Before the fight answers, the room just says no;
 *  - anywhere else, the database, through the API.
 */

/** Why an eat was refused, as the player reads it. */
const REFUSALS: Record<EatRefusal, string> = {
  down: "Your herzie is knocked out.",
  full: "Already at full health.",
  cooldown: "Not so fast.",
  "none-left": "None left.",
  "not-consumable": "You can't eat that.",
  "not-here": "You can't eat that here.",
  failed: "Couldn't eat that. Try again.",
};

/** When the last eat started (performance.now() ms), for the cooldown and
 * the hotbar's shade. */
let lastAt = Number.NEGATIVE_INFINITY;
/** Waiting on the room's `ate`, by seq. */
const waiting = new Map<
  number,
  (m: Extract<ServerMessage, { t: "ate" }>) => void
>();
let seq = 0;

/** How long until the next consumable may be eaten (ms, 0 when it can):
 * the hotbar's cooldown shade over a consumable's slot. */
export function eatCooldownLeft(now: number): number {
  return Math.max(0, lastAt + CONSUMABLE_COOLDOWN_MS - now);
}

/** The room's answer to an `eat`: townNet hands it here. */
export function settleEat(m: Extract<ServerMessage, { t: "ate" }>): void {
  waiting.get(m.seq)?.(m);
  waiting.delete(m.seq);
}

function ateLine(itemId: string, heal: number) {
  const name = getItem(itemId)?.name ?? itemId;
  pushLootLog(`Ate "${name}" (+${Math.round(heal)} HP)`);
}

/** Eat one `itemId`. Refusals go to `onRefused` (a toast over the Town by
 * default); resolves whether it was eaten. */
export async function eat(
  itemId: string,
  onRefused: (message: string) => void = notify,
): Promise<boolean> {
  const now = performance.now();
  if (now - lastAt < CONSUMABLE_COOLDOWN_MS) return false;
  const refuse = (reason: EatRefusal): false => {
    onRefused(REFUSALS[reason]);
    return false;
  };
  if (!getItem(itemId)?.consumable) return refuse("not-consumable");

  // Where a fight holds your health (the cave, the Tower), the room eats.
  if (townSave.map === "bossroom" || townSave.map === "tower") {
    const you = bossFight.you;
    const mine = you === null ? undefined : bossFight.health.get(you);
    if (mine && mine.hp <= 0) return refuse("down");
    if (mine && mine.hp >= mine.maxHp) return refuse("full");
    const n = ++seq;
    const answer = new Promise<Extract<ServerMessage, { t: "ate" }> | null>(
      (resolve) => {
        waiting.set(n, resolve);
        // A room that never answers (a dropped socket) eats nothing.
        setTimeout(() => {
          if (waiting.delete(n)) resolve(null);
        }, 5_000);
      },
    );
    if (!townNet().sendEat(itemId, n)) {
      waiting.delete(n);
      return refuse("not-here");
    }
    lastAt = now;
    const m = await answer;
    if (!m?.ok) return refuse(m?.reason ?? "failed");
    ateLine(itemId, m.heal ?? 0);
    // The room used it up in the database: bring the bank up to date.
    herzies.fetchInventory().catch(() => {});
    return true;
  }

  const v = getVitals();
  if (v?.down) return refuse("down");
  if (v && liveHp(v, Date.now()) >= v.maxHp) return refuse("full");
  lastAt = now;
  try {
    const res = await herzies.eatItem(itemId);
    setVitals(res.vitals);
    // In a room the HP update pops this; here nothing else would.
    pushHealNumber(null, res.heal);
    ateLine(itemId, res.heal);
    return true;
  } catch (e) {
    onRefused(typeof e === "string" ? e : REFUSALS.failed);
    return false;
  }
}
