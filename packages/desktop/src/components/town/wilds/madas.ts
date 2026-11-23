import { WILDS_SAFE_CAMP, type WildsService } from "@herzies/shared/wilds";
import {
  WILDS_CACHE_EVERY_MS,
  WILDS_CACHE_FIRST_MS,
} from "@herzies/shared/wilds-loot";
import { clock, sailingTime } from "../airship/status";
import { compassFrom } from "./loot";

/**
 * What Madas says, in the Wilds' safe camp: he's lost his wits to gold, but
 * he always knows where the cache is and when the next turns up. Pure (the
 * cache's times from the event's window, as the room keeps them), so it's
 * tested without a world; his panel works them out again every second.
 */

/** What he says whatever's going on. */
export const MADAS_FLAVOUR_LINES = [
  "Gold. Gold, gold, gold. Did you say something? Gold.",
  "Don't look at my pockets. There's nothing in my pockets. They're full of gold.",
  "I touched a tree once. Now it's mine. Everything I touch is mine. Don't shake my hand.",
  "They call me Madas. They used to call me something else. I sold it.",
  "Shh. The caches can hear you. They're shy. They only come out for me.",
  "You've a lovely shine about you. Stand still a moment. Stiller.",
] as const;

/** When the next cache turns up after `now`, for the Wilds open on
 * `service` (as wildsCacheAt counts them). Null: none before they close. */
export function nextCacheAt(service: WildsService, now: number): number | null {
  const first = service.startsAt + WILDS_CACHE_FIRST_MS;
  const at =
    now < first
      ? first
      : first +
        (Math.floor((now - first) / WILDS_CACHE_EVERY_MS) + 1) *
          WILDS_CACHE_EVERY_MS;
  return at < service.endsAt ? at : null;
}

/**
 * His lines at `now`: with the Wilds open on `service` (null: they aren't),
 * the next opening at `upcoming` (null: none planned), and the cache out now
 * where the room says (null: none, or you're not on the Wilds to hear it).
 */
export function madasLines(
  service: WildsService | null,
  upcoming: number | null,
  cache: { x: number; z: number } | null,
  now: number,
): string[] {
  const open = service && now >= service.startsAt && now < service.endsAt;
  if (!open) {
    return [
      upcoming === null
        ? "Closed. The Wilds are closed. Who closed them? Was it you?"
        : `The Wilds open ${sailingTime(upcoming, now)}. I'll be here. I'm always here. I can't leave the gold.`,
      "No caches while it's shut. I've counted my teeth eleven times. Still not gold.",
      ...MADAS_FLAVOUR_LINES,
    ];
  }
  const lines: string[] = [];
  if (cache) {
    lines.push(
      `There's one out now, ${compassFrom(WILDS_SAFE_CAMP, cache)}! Glinting! Calling me!`,
      "Go on, then. Hold it ten seconds and it's yours. Bring it back and we'll split it. Ninety, ten.",
    );
  }
  const next = nextCacheAt(service, now);
  lines.push(
    next === null
      ? "No more caches before they shut. Not one. I checked. I checked twice."
      : `The next one turns up in ${clock(next - now)}. I can feel it in my teeth.`,
  );
  return [...lines, ...MADAS_FLAVOUR_LINES];
}
