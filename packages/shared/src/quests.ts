import { PIP_KEY, PIP_NAME } from "./pip.js";

// Quests: small tasks handed out by Town NPCs. Each giver offers one quest a
// day (UTC), picked from their pool; you accept it from them, it completes on
// its own as you listen, and you turn it in to them for the reward. The rows
// live in user_quests (00130); progress is made server side, per kind.

/** How a quest's progress is made. Each kind has its own hook on the server.
 * - `new_artist`: play an artist with no earlier row in your listen history
 *   (quest_note_artist, called from sync on a track change). */
export type QuestKind = "new_artist";

export interface QuestDef {
  /** Stable id, stored on the row (user_quests.quest_id). */
  id: string;
  /** Who gives it: an NPC key (PIP_KEY). */
  giver: string;
  title: string;
  description: string;
  kind: QuestKind;
  /** How much progress completes it. */
  target: number;
  /** Paid on turn-in: coins (quests don't give XP; that's listening's). */
  reward: { coins: number };
}

export const QUESTS: readonly QuestDef[] = [
  {
    id: "pip_new_artist",
    giver: PIP_KEY,
    title: "Something New",
    description: "Listen to an artist you've never listened to before.",
    kind: "new_artist",
    target: 1,
    reward: { coins: 500 },
  },
];

/** Everyone who gives quests, by key, with the name shown for them. */
export const QUEST_GIVERS: Readonly<Record<string, string>> = {
  [PIP_KEY]: PIP_NAME,
};

export function getQuest(id: string): QuestDef | undefined {
  return QUESTS.find((q) => q.id === id);
}

/** The quest a giver offers on a day (`YYYY-MM-DD`, UTC): one from their
 * pool, the same for everyone that day. Undefined for a giver with none. */
export function dailyQuestFor(
  giver: string,
  day: string,
): QuestDef | undefined {
  const pool = QUESTS.filter((q) => q.giver === giver);
  if (pool.length === 0) return undefined;
  let h = 0;
  for (const c of `${giver}:${day}`) h = (h * 31 + c.charCodeAt(0)) | 0;
  return pool[Math.abs(h) % pool.length];
}
