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
  {
    id: "cheer",
    name: "Cheer",
    description: "Both arms up, a hop and a whoop. Armless herzies just hop.",
  },
  {
    id: "sit",
    name: "Sit",
    description:
      "Plop down wherever you are. Play it again, or move, to get up.",
  },
  {
    id: "micdrop",
    name: "Mic Drop",
    description: "Hold the mic up, let it go, and walk away. It lands loud.",
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
 * one herzie (the town-server enforces it too). Shorter than an emote: one
 * played again while it's still going carries it on (see HerzieModel.emote). */
export const EMOTE_SECONDS = 1.6;

/** How long each of the timed emotes plays (seconds). Wave has its own
 * clock (EMOTE_SECONDS) and sit has none: it lasts until you move. */
export const CHEER_SECONDS = 1.5;
export const MIC_DROP_SECONDS = 3.0;
export const EMOTE_COOLDOWN_MS = 800;

/** Emotes with a cooldown of their own (ms, from when it was played), where
 * one that leaves something behind mustn't be played over itself: a Mic Drop
 * can be played again about 2s after its mic lands (it's let go 1.8s in and
 * falls for a moment), and the new mic replaces the old. The model holds it
 * to the landing exactly; this is the town-server's floor under it. */
export const EMOTE_COOLDOWN_BY_ID: Readonly<Partial<Record<EmoteId, number>>> =
  { micdrop: 4_000 };

/** The least time (ms) before `id` can be played again. */
export function emoteCooldownMs(id: string): number {
  return EMOTE_COOLDOWN_BY_ID[id as EmoteId] ?? EMOTE_COOLDOWN_MS;
}
