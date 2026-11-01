import {
  dailyQuestFor,
  getQuest,
  QUEST_GIVERS,
  type QuestDef,
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
  offers: Record<string, QuestDef | null>;
}

interface DbQuest {
  id: string;
  questId: string;
  giver: string;
  title: string;
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
      description: def?.description ?? "",
      progress: r.progress,
      target: r.target,
      status: r.status,
      day: r.day,
      reward: def?.reward ?? null,
    };
  });

  const offers: Record<string, QuestDef | null> = {};
  for (const giver of Object.keys(QUEST_GIVERS)) {
    const held = rows.some(
      (r) => r.giver === giver && (r.day === today || r.status === "complete"),
    );
    offers[giver] = held ? null : (dailyQuestFor(giver, today) ?? null);
  }
  return { quests, offers };
}
