import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";

const LEADERBOARD_LIMIT = 100;

/**
 * Top herzies by XP (all-time), by XP gained this calendar month (UTC,
 * ?board=xp_month), by song hunts won (?board=song_hunt), by the highest
 * Tower floor ever cleared, across every Tower event (?board=tower), or by
 * the highest floor in this month's Towers (?board=tower_month: Tower events
 * starting this calendar month, UTC — the monthly Tower resets on the 1st).
 * Returns only aggregate, non-private stats — never now-playing or listening
 * history.
 *
 * GET /api/leaderboard
 * GET /api/leaderboard?board=xp_month
 * GET /api/leaderboard?board=song_hunt
 * GET /api/leaderboard?board=tower
 * GET /api/leaderboard?board=tower_month
 *
 * Each board also comes as "<board>_friends" (xp_friends, tower_friends, ...):
 * ranked among the caller and their friends only.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const admin = createAdminClient();
  const param = new URL(request.url).searchParams.get("board") ?? "xp";
  // Any board with "_friends" on the end: just the caller and their friends.
  const friendsOnly = param.endsWith("_friends");
  const board = friendsOnly ? param.slice(0, -"_friends".length) : param;
  let userIds: string[] | null = null;
  if (friendsOnly) {
    userIds = await friendUserIds(admin, auth.userId);
    if (userIds.length === 0) return NextResponse.json({ entries: [] });
  }

  if (board === "song_hunt") {
    const { data: winners, error: winnersError } = userIds
      ? await songHuntWinsAmong(admin, userIds)
      : ((await admin.rpc("top_song_hunt_winners", {
          p_limit: LEADERBOARD_LIMIT,
        })) as {
          data: { user_id: string; wins: number }[] | null;
          error: unknown;
        });
    if (winnersError || !winners || winners.length === 0) {
      return NextResponse.json({ entries: [] });
    }

    const { data: herzies, error: herziesError } = await admin
      .from("herzies")
      .select("user_id, name, level, stage, total_minutes_listened")
      .in(
        "user_id",
        winners.map((w) => w.user_id),
      );

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

  if (board === "tower" || board === "tower_month") {
    // Best floor per herzie per event (00115): keep each herzie's highest,
    // the earlier one winning a tie.
    let towerQuery =
      board === "tower_month"
        ? admin
            .from("tower_progress")
            .select("user_id, best_floor, updated_at, events!inner(starts_at)")
            .gte("events.starts_at", monthStart(0))
            .lt("events.starts_at", monthStart(1))
            .gt("best_floor", 0)
        : admin
            .from("tower_progress")
            .select("user_id, best_floor, updated_at")
            .gt("best_floor", 0);
    if (userIds) towerQuery = towerQuery.in("user_id", userIds);
    const { data: rows, error: rowsError } = await towerQuery
      .order("best_floor", { ascending: false })
      .order("updated_at", { ascending: true })
      .limit(LEADERBOARD_LIMIT * 10);
    if (rowsError || !rows || rows.length === 0) {
      return NextResponse.json({ entries: [] });
    }
    const best = new Map<string, number>();
    for (const r of rows) {
      if (best.size >= LEADERBOARD_LIMIT) break;
      if (!best.has(r.user_id)) best.set(r.user_id, r.best_floor as number);
    }

    const { data: herzies, error: herziesError } = await admin
      .from("herzies")
      .select("user_id, name, level, stage, total_minutes_listened")
      .in("user_id", [...best.keys()]);
    if (herziesError || !herzies) {
      return NextResponse.json({ entries: [] });
    }

    const herzieByUserId = new Map(herzies.map((h) => [h.user_id, h]));
    const entries = [...best]
      .map(([userId, floor]) => {
        const h = herzieByUserId.get(userId);
        if (!h) return null;
        return {
          name: h.name as string,
          level: (h.level as number) ?? 1,
          stage: (h.stage as number) ?? 1,
          totalMinutes: Math.floor((h.total_minutes_listened as number) ?? 0),
          towerFloor: floor,
        };
      })
      .filter((e) => e !== null)
      .map((e, i) => ({ rank: i + 1, ...e }));

    return NextResponse.json({ entries });
  }

  if (board === "xp_month") {
    // First of this month, UTC — the key 00119's trigger writes under.
    const now = new Date();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    let query = admin
      .from("herzie_xp_monthly")
      .select("user_id, xp")
      .eq("month", month)
      .gt("xp", 0);
    if (userIds) query = query.in("user_id", userIds);
    const { data: rows, error: rowsError } = await query
      .order("xp", { ascending: false })
      .limit(LEADERBOARD_LIMIT);
    if (rowsError || !rows || rows.length === 0) {
      return NextResponse.json({ entries: [] });
    }

    const { data: herzies, error: herziesError } = await admin
      .from("herzies")
      .select("user_id, name, level, stage, total_minutes_listened")
      .in(
        "user_id",
        rows.map((r) => r.user_id),
      );
    if (herziesError || !herzies) {
      return NextResponse.json({ entries: [] });
    }

    const herzieByUserId = new Map(herzies.map((h) => [h.user_id, h]));
    const entries = rows
      .map((r) => {
        const h = herzieByUserId.get(r.user_id);
        if (!h) return null;
        return {
          name: h.name as string,
          level: (h.level as number) ?? 1,
          stage: (h.stage as number) ?? 1,
          totalMinutes: Math.floor((h.total_minutes_listened as number) ?? 0),
          xp: Number(r.xp),
        };
      })
      .filter((e) => e !== null)
      .map((e, i) => ({ rank: i + 1, ...e }));

    return NextResponse.json({ entries });
  }

  let query = admin
    .from("herzies")
    .select("name, level, stage, total_minutes_listened, xp");
  if (userIds) query = query.in("user_id", userIds);
  const { data, error } = await query
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
    xp: Math.floor((row.xp as number) ?? 0),
  }));

  return NextResponse.json({ entries });
}

/** The first of this month (offset 0) or a later one, UTC, as ISO. */
function monthStart(offset: number): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1),
  ).toISOString();
}

/** The caller and their friends, as user ids. Empty without a herzie. */
async function friendUserIds(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<string[]> {
  const { data: me } = await admin
    .from("herzies")
    .select("friend_codes")
    .eq("user_id", userId)
    .maybeSingle();
  if (!me) return [];
  const codes = (me.friend_codes as string[] | null) ?? [];
  if (codes.length === 0) return [userId];
  const { data: friends } = await admin
    .from("herzies")
    .select("user_id")
    .in("friend_code", codes);
  return [userId, ...(friends ?? []).map((f) => f.user_id as string)];
}

/** Song hunts won by each of `userIds` (the friends board), most first —
 * top_song_hunt_winners (00047) for a given set of herzies. */
async function songHuntWinsAmong(
  admin: ReturnType<typeof createAdminClient>,
  userIds: string[],
): Promise<{
  data: { user_id: string; wins: number }[] | null;
  error: unknown;
}> {
  const { data, error } = await admin
    .from("event_claims")
    .select("user_id, events!inner(type)")
    .eq("events.type", "song_hunt")
    .in("user_id", userIds);
  if (error || !data) return { data: null, error };
  const wins = new Map<string, number>();
  for (const row of data) {
    const id = row.user_id as string;
    wins.set(id, (wins.get(id) ?? 0) + 1);
  }
  return {
    data: [...wins]
      .map(([user_id, n]) => ({ user_id, wins: n }))
      .sort((a, b) => b.wins - a.wins),
    error: null,
  };
}
