/**
 * Emotes: little animations a herzie plays on demand, in the Town. Premium,
 * and unlocked for good on the herzie rather than held as items — so they
 * take no bag slot and can't be traded. They are sold like the Bigger Bag: a
 * Stripe product whose `metadata.emote_id` names one, granted by
 * fulfill_store_order into `herzies.emotes`.
 *
 * Played from the Alt bar (Alt+1, Alt+2, …), which fills itself with the
 * emotes you own in this list's order, and shown to everyone in the room
 * through the town-server, which checks the signed ticket says you own it.
 */
export interface EmoteDef {
  id: string;
  name: string;
  description: string;
}

export const EMOTES = [
  {
    id: "wave",
    name: "Wave",
    description:
      "Say hi. Herzies without arms yet do a little spin jump instead.",
  },
] as const satisfies readonly EmoteDef[];

export type EmoteId = (typeof EMOTES)[number]["id"];

export const EMOTE_IDS: readonly EmoteId[] = EMOTES.map((e) => e.id);

export function getEmote(id: string): EmoteDef | undefined {
  return EMOTES.find((e) => e.id === id);
}

export function isEmoteId(id: unknown): id is EmoteId {
  return typeof id === "string" && EMOTE_IDS.includes(id as EmoteId);
}

/** The emotes owned, in catalog order (the Alt bar's order), dropping any
 * id this build doesn't know. */
export function ownedEmotes(
  owned: readonly string[] | null | undefined,
): EmoteId[] {
  if (!owned?.length) return [];
  return EMOTE_IDS.filter((id) => owned.includes(id));
}

/** How long an emote plays (seconds), and the least time between two from
 * one herzie (the town-server enforces it too). */
export const EMOTE_SECONDS = 1.6;
export const EMOTE_COOLDOWN_MS = 2000;
