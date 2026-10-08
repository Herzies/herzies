import { MERCHANT_NAME, TREAT_TRADER_NAME } from "./types.js";

/** Event types that show up in Town as a visitor. */
export type VisitorEventType =
  | "song_hunt"
  | "merchant"
  | "treat_trader"
  | "boss_fight"
  | "secret_track";

export interface Visitor {
  /** Who turns up. For a boss this is only the fallback: each boss has its
   * own name (the event's title), so the boss *is* the visitor. */
  name: string;
  /** Finishes "<name> …" while they're in town. */
  tagline: string;
  /** Fixed creature seed, so a visitor looks the same for everyone (an NPC
   * seed, never a real user id — same idea as George's). */
  seed?: string;
}

/**
 * The Town's cast, one per event type. An event is a *visit*: the visitor
 * stays for the event's window and leaves when it ends. A single visit can
 * still carry its own title and flavour text; this is the persona behind it.
 *
 * Code, database and API keep calling these events (`events`, `song_hunt`,
 * …); only what players read says "visitor".
 */
export const VISITORS: Record<VisitorEventType, Visitor> = {
  // A play on Orpheus, forever looking for Eurydice — Orphiez is looking for
  // a song he lost, and a song hunt is players helping him find it.
  song_hunt: {
    name: "Orphiez",
    tagline: "is looking for a song he lost",
    seed: "npc:orphiez",
  },
  merchant: {
    name: MERCHANT_NAME,
    tagline: "has wares, if you have coin",
    seed: "npc:good-ol-george",
  },
  // A spin on Nandor the Relentless (What We Do in the Shadows). A limited
  // Halloween visitor who trades the season's items for Treats.
  treat_trader: {
    name: TREAT_TRADER_NAME,
    tagline: "demands your treats",
    seed: "npc:nandor-the-treatless",
  },
  boss_fight: {
    name: "The next boss",
    tagline: "is tearing through town",
  },
  secret_track: {
    name: "The Busker",
    tagline: "left a track behind",
  },
};

export function isVisitorType(type: string): type is VisitorEventType {
  return type in VISITORS;
}

/** What a visit is called in Town: the boss by its own name, everyone else
 * by their persona. */
export function visitorName(type: string, eventTitle?: string | null): string {
  if (type === "boss_fight" && eventTitle?.trim()) return eventTitle;
  return isVisitorType(type) ? VISITORS[type].name : (eventTitle ?? type);
}
