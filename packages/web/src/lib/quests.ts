import {
  getQuest,
  QUEST_GIVERS,
  type QuestDef,
  type QuestOffer,
  type QuestParams,
  questOfferFor,
} from "@herzies/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

/** A quest you hold, as the Quests window and its giver show it. */
export interface QuestRow {
  id: string;
  questId: string;
  giver: string;
  giverName: string;
  title: string;
  description: string;
  progress: number;
  target: number;
  status: "active" | "complete" | "claimed";
  day: string;
  reward: QuestDef["reward"] | null;
}

export interface QuestBoard {
  quests: QuestRow[];
  /** Per giver: today's quest if you can take it, else null. */
  offers: Record<string, QuestOffer | null>;
}

interface DbQuest {
  id: string;
  questId: string;
  giver: string;
  title: string;
  description: string | null;
  kind: string;
  params: QuestParams | null;
  day: string;
  progress: number;
  target: number;
  status: QuestRow["status"];
}

/** Today in UTC, as quests count days (`YYYY-MM-DD`). */
export function questDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Your quests (quests_json, 00130) and what each giver offers today. You
 * hold one quest per giver at a time: none is offered while you have today's
 * or a finished one still to turn in. */
export async function loadQuestBoard(
  admin: SupabaseClient,
  userId: string,
): Promise<QuestBoard | null> {
  const { data, error } = await admin.rpc("quests_json", { p_user: userId });
  if (error || !Array.isArray(data)) return null;
  const rows = data as DbQuest[];
  const today = questDay();

  const quests: QuestRow[] = rows.map((r) => {
    const def = getQuest(r.questId);
    return {
      id: r.id,
      questId: r.questId,
      giver: r.giver,
      giverName: QUEST_GIVERS[r.giver] ?? r.giver,
      title: r.title,
      description: r.description ?? def?.description ?? "",
      progress: r.progress,
      target: r.target,
      status: r.status,
      day: r.day,
      reward: def?.reward ?? null,
    };
  });

  const offers: Record<string, QuestOffer | null> = {};
  const open = Object.keys(QUEST_GIVERS).filter(
    (giver) =>
      !rows.some(
        (r) =>
          r.giver === giver && (r.day === today || r.status === "complete"),
      ),
  );
  const found = open.length > 0 ? await foundGenres(admin, userId) : [];
  for (const giver of Object.keys(QUEST_GIVERS)) {
    offers[giver] = open.includes(giver)
      ? (questOfferFor(giver, userId, today, found) ?? null)
      : null;
  }
  return { quests, offers };
}

/** Genres Pip has already asked this player for: every genre quest they
 * took, finished or not. He comes up with a new one each time. */
export async function foundGenres(
  admin: SupabaseClient,
  userId: string,
): Promise<string[]> {
  const { data } = await admin
    .from("user_quests")
    .select("params")
    .eq("user_id", userId)
    .eq("kind", "genre");
  return (data ?? [])
    .map((r) => (r.params as QuestParams | null)?.genre)
    .filter((g): g is string => typeof g === "string");
}
