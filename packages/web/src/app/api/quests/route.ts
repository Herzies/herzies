import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { loadQuestBoard } from "@/lib/quests";
import { createAdminClient } from "@/lib/supabase-admin";

/** Your quests and what each quest giver offers today (00130). */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const board = await loadQuestBoard(createAdminClient(), auth.userId);
  if (!board) {
    return NextResponse.json(
      { error: "Failed to load quests" },
      { status: 500 },
    );
  }
  return NextResponse.json(board);
}
