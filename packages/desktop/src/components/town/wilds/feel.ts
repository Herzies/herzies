import { notify } from "../../../lib/notices";
import {
  pushBlockedLabel,
  pushDamageNumber,
  pushHealNumber,
  pushStunLabel,
} from "../combat/DamageNumbers";
import { entityAt } from "../combat/skills";
import { combat, shake } from "../combat/state";
import { FX, flashFighter, leanFighter, stopFighter } from "../duel/fx";
import {
  sfxDuelBlocked,
  sfxDuelDefeat,
  sfxDuelThock,
  sfxHealBolt,
  sfxHurt,
  sfxStun,
} from "../sfx";
import { onWildsEvent, type WildsEvent, wilds } from "./store";

/**
 * What a fight in the Wilds feels like, from the store's events: your
 * blows' numbers and thocks, the flash and lean on whoever's hit, your own
 * hurt (a shake, a grunt), stuns, and the line when someone's taken down.
 * The same look as a duel's blows (duel/fx), with no ring or banner: this
 * is a brawl anyone may walk into.
 */

/** The text over a herzie: its top, a touch higher. */
function over(id: number): [number, number, number] | null {
  const e = entityAt.get(id);
  return e ? [e.x, e.top + 0.3, e.z] : null;
}

function onEvent(e: WildsEvent) {
  const now = performance.now();
  switch (e.k) {
    case "hp": {
      if (e.hp > e.was) {
        pushHealNumber(e.id === wilds.you ? null : e.id, e.hp - e.was);
        if (e.id === wilds.you) sfxHealBolt();
        return;
      }
      flashFighter(e.id, now);
      const big = (e.was - e.hp) / e.maxHp > 0.12;
      stopFighter(e.id, big ? FX.critStopMs : FX.stopMs, now);
      const from = e.by === null ? undefined : entityAt.get(e.by);
      const to = entityAt.get(e.id);
      if (from && to) leanFighter(e.id, to.x - from.x, to.z - from.z, now);
      if (e.id === wilds.you) {
        shake(big ? 0.38 : 0.26);
        sfxHurt();
      }
      return;
    }
    case "hit": {
      const at = over(e.target);
      if (e.blocked) {
        if (at) pushBlockedLabel(at);
        sfxDuelBlocked();
        return;
      }
      if (at) {
        const jitter = () => (Math.random() - 0.5) * 0.6;
        pushDamageNumber(
          [at[0] + jitter(), at[1], at[2] + jitter()],
          e.damage,
          e.crit,
          `pvp${e.target}`,
        );
      }
      combat.hitAt = now;
      combat.hitCrit = e.crit;
      if (combat.trauma < 0.3) shake(e.crit ? 0.22 : 0.08);
      sfxDuelThock(e.crit);
      return;
    }
    case "stun": {
      const at = over(e.id);
      if (at && e.until > now) {
        pushStunLabel(at);
        sfxStun();
      }
      return;
    }
    case "down":
      if (e.id === wilds.you) sfxDuelDefeat();
      return;
    case "up":
      return;
    case "feed":
      notify(e.text, { kind: e.won ? "success" : "info" });
      return;
  }
}

onWildsEvent(onEvent);
