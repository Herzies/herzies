import { QUEST_GIVERS, questOfferFor } from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { foundGenres, loadQuestBoard, questDay } from "@/lib/quests";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, { status: number; error: string }> = {
  "already-taken": { status: 409, error: "You already have today's quest" },
  "turn-in-first": {
    status: 409,
    error: "Turn in your finished quest first",
  },
};

/** Take today's quest from a giver. The giver picks it, and its genre or
 * year (questOfferFor, the same as the board offered): the client only says
 * who it's talking to. Answers with the fresh board. */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = (await request.json().catch(() => null)) as {
    giver?: unknown;
  } | null;
  const giver = typeof body?.giver === "string" ? body.giver : "";
  if (!QUEST_GIVERS[giver]) {
    return NextResponse.json({ error: "Unknown quest giver" }, { status: 400 });
  }
  const admin = createAdminClient();
  const quest = questOfferFor(
    giver,
    auth.userId,
    questDay(),
    await foundGenres(admin, auth.userId),
  );
  if (!quest) {
    return NextResponse.json({ error: "No quest today" }, { status: 404 });
  }

  const { data, error } = await admin.rpc("quest_accept", {
    p_user: auth.userId,
    p_giver: giver,
    p_quest: quest.id,
    p_title: quest.title,
    p_kind: quest.kind,
    p_target: quest.target,
    p_params: quest.params,
    p_description: quest.description,
  });
  if (error) {
    return NextResponse.json({ error: "Failed to accept" }, { status: 500 });
  }
  const result = data as { ok: boolean; reason?: string } | null;
  if (!result?.ok) {
    const known = REASONS[result?.reason ?? ""];
    return NextResponse.json(
      { error: known?.error ?? "Failed to accept", reason: result?.reason },
      { status: known?.status ?? 400 },
    );
  }

  const board = await loadQuestBoard(admin, auth.userId);
  return NextResponse.json({ ok: true, quest, board });
}
