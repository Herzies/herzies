/**
 * What the dev bots (duel-bot.mjs, wilds-bot.mjs) are as herzies: their
 * class's instrument and gear, its skills, and their stat points spent as
 * a player of that class would. They sign their own tickets from this, so
 * the Town server judges them like anyone; nothing is special-cased there.
 */
import { CLASS_IDS, instrumentOf } from "@herzies/shared/classes";
import { getHerzieStats, withStatPoints } from "@herzies/shared/items";
import { maxHp } from "@herzies/shared/vitals";

/** `raw` if it names a class, else `fallback`. */
export function classOr(raw, fallback) {
  return CLASS_IDS.includes(raw) ? raw : fallback;
}

/** What it holds and where its points go, like a player of its class. */
const GEAR = {
  bard: { main_hand: "lute" },
  record_slinger: { main_hand: "compact-discs" },
  percussionist: { main_hand: "worn-stick", off_hand: "old-cymbal" },
};
const SKILLS = {
  bard: [["soothing-drones", 5], ["haste", 5]],
  record_slinger: [["backspin", 5], ["shuffle", 5]],
  percussionist: [["cymbrella", 5], ["rimshot", 5]],
};

function points(cls, level) {
  const n = 2 * Math.max(0, level - 1);
  if (cls === "bard")
    return { stamina: 0, sonicPower: Math.ceil(n / 2), euphony: Math.floor(n / 2), timing: 0 };
  if (cls === "percussionist") {
    const stamina = Math.round(n * 0.7);
    return { stamina, sonicPower: n - stamina, euphony: 0, timing: 0 };
  }
  return { stamina: 0, sonicPower: n, euphony: 0, timing: 0 };
}

/** A class `cls` herzie at `level`: what it wears (`gear`, for its look)
 * and its ticket's fight fields (health, stats, level, class, skills). */
export function herzieKit(cls, level) {
  const lv = Math.max(1, Math.min(200, Math.round(level)));
  const gear = { ...GEAR[cls], main_hand: instrumentOf(cls) ?? GEAR[cls].main_hand };
  const s = withStatPoints(getHerzieStats(gear), points(cls, lv), lv);
  const max = maxHp(lv, s.stamina);
  return {
    gear,
    hp: { hp: max, maxHp: max, down: false },
    st: [s.sonicPower, s.luck, s.critChance, s.critDamage, s.stamina, s.def, s.euphony, s.timing],
    lv,
    cls,
    sk: SKILLS[cls],
  };
}
