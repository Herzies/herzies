import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";

const LEADERBOARD_LIMIT = 100;

/**
 * Top herzies by XP. Returns only aggregate, non-private stats — never
 * now-playing or listening history.
 *
 * GET /api/leaderboard
 */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("herzies")
    .select("name, level, stage, total_minutes_listened")
    .order("xp", { ascending: false })
    .limit(LEADERBOARD_LIMIT);

  if (error || !data) {
    return NextResponse.json({ entries: [] });
  }

  const entries = data.map((row, i) => ({
    rank: i + 1,
    name: row.name as string,
    level: (row.level as number) ?? 1,
    stage: (row.stage as number) ?? 1,
    totalMinutes: Math.floor((row.total_minutes_listened as number) ?? 0),
  }));

  return NextResponse.json({ entries });
}
