/**
 * Herzies as a real ticket carries them, for the sims: each class's gear,
 * where it puts its stat points, and withStatPoints over them at a level,
 * as town-ticket builds `st`.
 */
import { getHerzieStats, withStatPoints } from "@herzies/shared/items";
import type { StatPoints } from "@herzies/shared/stats";
import type { TownTicketPayload } from "@herzies/shared/town-net";
import { maxHp as maxHpOf } from "@herzies/shared/vitals";

export type Role = "bard" | "percussionist" | "record_slinger" | "none";

/** What each class wears into a fight (its instruments). */
export const GEAR: Record<Role, Record<string, string>> = {
  record_slinger: { main_hand: "compact-discs" },
  bard: { main_hand: "lute" },
  percussionist: { main_hand: "worn-stick", off_hand: "old-cymbal" },
  none: {},
};

/** Where each class puts its points (2 a level after the first): a
 * Slinger all in Sonic Power, a Bard half in Euphony, a tank mostly in
 * Stamina. */
export function pointsFor(role: Role, level: number): StatPoints {
  const n = 2 * Math.max(0, level - 1);
  if (role === "bard")
    return { stamina: 0, sonicPower: Math.ceil(n / 2), euphony: Math.floor(n / 2), timing: 0 };
  if (role === "percussionist") {
    const stamina = Math.round(n * 0.7);
    return { stamina, sonicPower: n - stamina, euphony: 0, timing: 0 };
  }
  return { stamina: 0, sonicPower: n, euphony: 0, timing: 0 };
}

/** A herzie's stats for its class at `level`, as town-ticket builds them. */
export function statsFor(
  role: Role,
  level: number,
): {
  st: [number, number, number, number, number, number, number, number];
  stamina: number;
  timing: number;
} {
  const s = withStatPoints(
    getHerzieStats(GEAR[role] as Parameters<typeof getHerzieStats>[0]),
    pointsFor(role, level),
    level,
  );
  return {
    st: [s.sonicPower, s.luck, s.critChance, s.critDamage, s.stamina, s.def, s.euphony, s.timing],
    stamina: s.stamina,
    timing: s.timing,
  };
}

export function skillsFor(role: Role): [string, number][] {
  if (role === "bard")
    return [["soothing-drones", 5], ["resurrect", 5], ["haste", 5]];
  if (role === "percussionist")
    return [["cymbrella", 5], ["taunt", 5], ["rimshot", 5]];
  if (role === "record_slinger") return [["backspin", 5], ["shuffle", 5]];
  return [];
}

/** A ticket for `uid`, a `role` at `level`, at full health. */
export function realTicket(uid: string, role: Role, level: number): TownTicketPayload {
  const { st, stamina } = statsFor(role, level);
  const max = maxHpOf(level, stamina);
  return {
    uid,
    name: uid,
    look: { seed: uid, stage: 3, equipped: GEAR[role] },
    exp: 9e9,
    hp: { hp: max, maxHp: max, down: false },
    st,
    lv: level,
    ...(role !== "none" ? { cls: role, sk: skillsFor(role) } : {}),
  } as TownTicketPayload;
}
