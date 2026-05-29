import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Look up herzies by friend code(s). Requires authentication.
 *
 * A herzie's listening data (now playing, last played, top artists) is
 * private: it is only included in the response when the authenticated caller
 * is friends with that herzie (or is looking up their own profile). For
 * everyone else only the public game stats (name, level, stage, appearance,
 * rank, …) are returned.
 *
 * GET /api/lookup?code=HERZ-XXXX          — single lookup
 * GET /api/lookup?codes=HERZ-XXXX,HERZ-YYYY — batch lookup
 */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const { searchParams } = new URL(request.url);
  const singleCode = searchParams.get("code");
  const batchCodes = searchParams.get("codes");

  if (!singleCode && !batchCodes) {
    return NextResponse.json(
      { error: "code or codes query param is required" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Codes whose listening data the caller is allowed to see: their own and
  // their confirmed friends.
  const { data: me } = await admin
    .from("herzies")
    .select("friend_code, friend_codes")
    .eq("user_id", auth.userId)
    .single();

  const visibleCodes = new Set<string>(me?.friend_codes ?? []);
  if (me?.friend_code) visibleCodes.add(me.friend_code);

  if (singleCode) {
    const { data, error } = await admin
      .from("herzies")
      .select(
        "user_id, name, friend_code, xp, stage, level, currency, appearance, equipped, now_playing",
      )
      .eq("friend_code", singleCode.toUpperCase().trim())
      .single();

    if (error || !data) {
      return NextResponse.json({ herzie: null });
    }

    const canSeeListening = visibleCodes.has(data.friend_code);
    const [topArtists, lastPlayed, globalRank, globalTotal] = await Promise.all(
      [
        canSeeListening
          ? getTopArtists(admin, data.user_id)
          : Promise.resolve([]),
        canSeeListening
          ? getLastPlayed(admin, data.user_id)
          : Promise.resolve(null),
        getGlobalRank(admin, data.xp),
        getGlobalTotal(admin),
      ],
    );

    return NextResponse.json({
      herzie: formatProfile(
        data,
        canSeeListening,
        topArtists,
        lastPlayed,
        globalRank,
        globalTotal,
      ),
    });
  }

  const codes = (batchCodes ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 50);

  if (codes.length === 0) {
    return NextResponse.json({ herzies: [] });
  }

  const { data, error } = await admin
    .from("herzies")
    .select(
      "user_id, name, friend_code, xp, stage, level, currency, appearance, equipped, now_playing",
    )
    .in("friend_code", codes);

  if (error || !data) {
    return NextResponse.json({ herzies: [] });
  }

  const globalTotal = await getGlobalTotal(admin);
  const herzies = await Promise.all(
    data.map(async (row) => {
      const canSeeListening = visibleCodes.has(row.friend_code);
      const [topArtists, lastPlayed, globalRank] = await Promise.all([
        canSeeListening
          ? getTopArtists(admin, row.user_id)
          : Promise.resolve([]),
        canSeeListening
          ? getLastPlayed(admin, row.user_id)
          : Promise.resolve(null),
        getGlobalRank(admin, row.xp),
      ]);
      return formatProfile(
        row,
        canSeeListening,
        topArtists,
        lastPlayed,
        globalRank,
        globalTotal,
      );
    }),
  );

  return NextResponse.json({ herzies });
}

type HerzieRow = {
  user_id: string;
  name: string;
  friend_code: string;
  xp: number;
  stage: number;
  level: number;
  currency: number | null;
  appearance: unknown;
  equipped: string[] | null;
  now_playing: { title?: string; artist?: string } | null;
};

function formatNowPlaying(
  np: { title?: string; artist?: string } | null,
): { title: string; artist: string } | null {
  if (!np?.title || !np?.artist) return null;
  return { title: np.title, artist: np.artist };
}

function formatProfile(
  row: HerzieRow,
  canSeeListening: boolean,
  topArtists: { name: string; plays: number }[],
  lastPlayed: { title: string; artist: string; listenedAt: string } | null,
  globalRank?: number,
  globalTotal?: number,
) {
  return {
    name: row.name,
    friendCode: row.friend_code,
    globalRank,
    globalTotal,
    stage: row.stage,
    level: row.level,
    currency: row.currency,
    appearance: row.appearance,
    topArtists: canSeeListening ? topArtists : [],
    equipped: row.equipped,
    nowPlaying: canSeeListening ? formatNowPlaying(row.now_playing) : null,
    lastPlayed: canSeeListening ? lastPlayed : null,
  };
}

async function getGlobalRank(
  admin: ReturnType<typeof createAdminClient>,
  xp: number,
): Promise<number | undefined> {
  const { count } = await admin
    .from("herzies")
    .select("friend_code", { count: "exact", head: true })
    .gt("xp", xp);

  if (typeof count !== "number") return undefined;
  return count + 1;
}

async function getGlobalTotal(
  admin: ReturnType<typeof createAdminClient>,
): Promise<number | undefined> {
  const { count } = await admin
    .from("herzies")
    .select("friend_code", { count: "exact", head: true });
  return typeof count === "number" ? count : undefined;
}

const LISTEN_LOG_PAGE_SIZE = 1000;

async function getLastPlayed(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<{ title: string; artist: string; listenedAt: string } | null> {
  const { data } = await admin
    .from("listen_log")
    .select("track_name, artist_name, listened_at")
    .eq("user_id", userId)
    .order("listened_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  return {
    title: data.track_name,
    artist: data.artist_name,
    listenedAt: data.listened_at,
  };
}

async function getTopArtists(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<{ name: string; plays: number }[]> {
  const counts: Record<string, number> = {};
  let from = 0;

  while (true) {
    const { data: page } = await admin
      .from("listen_log")
      .select("artist_name")
      .eq("user_id", userId)
      .range(from, from + LISTEN_LOG_PAGE_SIZE - 1);

    if (!page?.length) break;

    for (const row of page) {
      counts[row.artist_name] = (counts[row.artist_name] ?? 0) + 1;
    }

    if (page.length < LISTEN_LOG_PAGE_SIZE) break;
    from += LISTEN_LOG_PAGE_SIZE;
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, plays]) => ({ name, plays }));
}
