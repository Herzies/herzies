import { WILDS_SAFE_CAMP, type WildsService } from "@herzies/shared/wilds";
import { clock, sailingTime } from "../airship/status";
import { compassFrom } from "./loot";

/**
 * What the Hunt Crystal says when you talk to it: how full of gold it is,
 * who's playing it music and how long till it's full, or, once it is,
 * which way its treasure lies. Pure, so it's tested without a world; its
 * panel works them out again every second.
 */

/** The crystal as the room tells it: how full it is now (0 to 1), how
 * fast it's filling (a ms) and how many are listening. */
export type HuntState = { charge: number; rate: number; listeners: number };

/**
 * Its lines at `now`: with the Wilds open on `service` (null: they
 * aren't), the next opening at `upcoming` (null: none planned), the cache
 * out now where the room says, and its own state (each null: none, or not
 * heard yet).
 */
export function huntCrystalLines(
  service: WildsService | null,
  upcoming: number | null,
  cache: { x: number; z: number } | null,
  hunt: HuntState | null,
  now: number,
): string[] {
  const open = service && now >= service.startsAt && now < service.endsAt;
  if (!open)
    return [
      upcoming === null
        ? "…I sleep. The Wilds are shut."
        : `…I sleep. The Wilds open ${sailingTime(upcoming, now)}.`,
    ];
  if (cache)
    return [
      `I am full. My treasure lies ${compassFrom(WILDS_SAFE_CAMP, cache)}.`,
      "Follow my light. Where it ends, look about you.",
      "Stand in the treasure's ring until it is yours.",
    ];
  if (!hunt) return ["Play me music, and I turn to gold."];
  const gold = Math.floor(hunt.charge * 100);
  if (hunt.listeners === 0 || hunt.rate <= 0)
    return [
      gold === 0 ? "I am stone. Nobody plays." : `I am ${gold}% gold.`,
      "Play me music. Any music.",
    ];
  const who =
    hunt.listeners === 1 ? "One of you plays" : `${hunt.listeners} of you play`;
  return [
    `I am ${gold}% gold. ${who} for me.`,
    `Full in ${clock((1 - hunt.charge) / hunt.rate)}. More of you, sooner.`,
  ];
}
