import { WILDS_SAFE_CAMP, type WildsService } from "@herzies/shared/wilds";
import { clock, sailingTime } from "../airship/status";
import { compassFrom } from "./loot";

/**
 * What Madas says, in the Wilds' safe camp: he's lost his wits to gold, but
 * he always knows where the cache is, and how near the Hunt Crystal is to
 * bringing out the next. Pure, so it's tested without a world; his panel
 * works them out again every second.
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

/** The Hunt Crystal as he sees it: how full it is now (0 to 1), how fast
 * it's filling (a ms) and how many are listening. */
export type MadasHunt = { charge: number; rate: number; listeners: number };

/**
 * His lines at `now`: with the Wilds open on `service` (null: they aren't),
 * the next opening at `upcoming` (null: none planned), the cache out now
 * where the room says, and the Hunt Crystal (each null: none, or you're not
 * on the Wilds to see it).
 */
export function madasLines(
  service: WildsService | null,
  upcoming: number | null,
  cache: { x: number; z: number } | null,
  hunt: MadasHunt | null,
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
  } else if (hunt) {
    const gold = Math.floor(hunt.charge * 100);
    if (hunt.listeners === 0 || hunt.rate <= 0)
      lines.push(
        gold === 0
          ? "See the crystal? Grey as a gravestone. It wants music. Play it something! Anything!"
          : `The crystal's ${gold}% gold and nobody's playing it a note. It's going to sulk. I'm going to sulk.`,
      );
    else {
      const who =
        hunt.listeners === 1
          ? "One of you's playing"
          : `${hunt.listeners} of you are playing`;
      lines.push(
        `The crystal's ${gold}% gold. ${who}. More! Louder! More of you!`,
        `At this rate it's full in ${clock((1 - hunt.charge) / hunt.rate)}, and then the hunt's on. I can feel it in my teeth.`,
      );
    }
  } else {
    lines.push(
      "The crystal in the camp: play it music and it turns to gold, and when it's all gold, the hunt's on.",
    );
  }
  return [...lines, ...MADAS_FLAVOUR_LINES];
}
