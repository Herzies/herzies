import {
  nextDeparture,
  type ShipState,
  shipState,
  type WildsService,
} from "@herzies/shared";
import { clock, sailingTime } from "./status";

/**
 * What Sofia III's skipper says, on the pier at the home island's Sky Dock:
 * whether she's sailing, where she is and when she next leaves here. Pure,
 * from the timetable (as the dock's board is), so it's tested without a
 * world; his panel works them out again every second, so a countdown is
 * as fresh as the moment he says it.
 */

/** What he says whatever the timetable. */
export const SKIPPER_FLAVOUR_LINES = [
  "One ship in the whole sky, and she's mine to skipper.",
  "Mind the end of the pier. It's a long way down.",
] as const;

/** Where she is, in state `st`. */
function whereSheIs(st: ShipState, now: number): string {
  if (st.kind === "flying") {
    return st.to === "wilds"
      ? `She's out over the gap to the Wilds: there in ${clock(st.arrivesAt - now)}.`
      : `She's on her way home: alongside in ${clock(st.arrivesAt - now)}.`;
  }
  if (st.at === "wilds") {
    return st.until === null
      ? "She's tied up at the Wilds."
      : `She's tied up at the Wilds, casting off for home in ${clock(st.until - now)}.`;
  }
  return st.until === null
    ? "She's laid up here at the pier."
    : "She's alongside: up the gangplank with you.";
}

/** His lines at `now`, on `service` (null: none on), with the next one
 * opening at `upcoming` (null: none planned). */
export function skipperLines(
  service: WildsService | null,
  upcoming: number | null,
  now: number,
): string[] {
  const next = nextDeparture(service, "home", now);
  if (service && next) {
    const st = shipState(service, next.ship, now);
    return [
      `Sofia III's sailing. ${whereSheIs(st, now)}`,
      next.dockedFrom > now
        ? `She'll be alongside here in ${clock(next.dockedFrom - now)}, and off to the Wilds in ${clock(next.departsAt - now)}.`
        : `All aboard for the Wilds: she casts off in ${clock(next.departsAt - now)}.`,
      ...SKIPPER_FLAVOUR_LINES,
    ];
  }
  const later =
    upcoming === null
      ? null
      : `Next sailing's ${sailingTime(upcoming, now)}. Don't be late.`;
  if (service) {
    // Her last run has left here: she may still be out on it.
    const st = shipState(service, 0, now);
    const home = st.kind === "docked" && st.at === "home";
    return [
      home
        ? "She's made her last sailing for today. Laid up now, and so am I."
        : `That was her last sailing from here today. ${whereSheIs(st, now)}`,
      later ?? "Nothing more on the timetable yet.",
      ...SKIPPER_FLAVOUR_LINES,
    ];
  }
  if (later) {
    return [
      "Sofia III's laid up for now. She'll take you to the Wilds soon enough.",
      later,
      ...SKIPPER_FLAVOUR_LINES,
    ];
  }
  return [
    "Sofia III's laid up, and there's nothing on the timetable.",
    "No sailings planned. When the Wilds open, she'll sail.",
    ...SKIPPER_FLAVOUR_LINES,
  ];
}
