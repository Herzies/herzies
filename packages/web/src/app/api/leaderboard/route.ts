import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";

const LEADERBOARD_LIMIT = 100;

/**
 * Top herzies by XP, or (with ?board=song_hunt) by song hunts won. Returns
 * only aggregate, non-private stats — never now-playing or listening history.
 *
 * GET /api/leaderboard
 * GET /api/leaderboard?board=song_hunt
 */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const admin = createAdminClient();
  const board = new URL(request.url).searchParams.get("board");

  if (board === "song_hunt") {
    const { data: winners, error: winnersError } = (await admin.rpc(
      "top_song_hunt_winners",
      { p_limit: LEADERBOARD_LIMIT },
    )) as { data: { user_id: string; wins: number }[] | null; error: unknown };
    if (winnersError || !winners || winners.length === 0) {
      return NextResponse.json({ entries: [] });
    }

    const userIds = winners.map((w) => w.user_id);
    const { data: herzies, error: herziesError } = await admin
      .from("herzies")
      .select("user_id, name, level, stage, total_minutes_listened")
      .in("user_id", userIds);

    if (herziesError || !herzies) {
      return NextResponse.json({ entries: [] });
    }

    const herzieByUserId = new Map(herzies.map((h) => [h.user_id, h]));
    const entries = winners
      .map((w, i) => {
        const h = herzieByUserId.get(w.user_id);
        if (!h) return null;
        return {
          rank: i + 1,
          name: h.name as string,
          level: (h.level as number) ?? 1,
          stage: (h.stage as number) ?? 1,
          totalMinutes: Math.floor((h.total_minutes_listened as number) ?? 0),
          songHuntWins: w.wins,
        };
      })
      .filter((e) => e !== null);

    return NextResponse.json({ entries });
  }

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
