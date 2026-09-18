import { isModifierEquipped, normalizeEquipped } from "@herzies/shared";
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
        "user_id, name, friend_code, stage, level, currency, appearance, equipped, now_playing",
      )
      .eq("friend_code", singleCode.toUpperCase().trim())
      .single();

    if (error || !data) {
      return NextResponse.json({ herzie: null });
    }

    const canSeeListening = visibleCodes.has(data.friend_code);
    const equipped = normalizeEquipped(data.equipped);
    const wantsSongHuntWins = hasGoodEyeSniperEquipped(equipped);

    const [details, songHuntWins] = await Promise.all([
      fetchBatchDetails(
        admin,
        [data.user_id],
        canSeeListening ? [data.user_id] : [],
      ),
      wantsSongHuntWins
        ? getSongHuntWins(admin, data.user_id)
        : Promise.resolve(undefined),
    ]);
    const rank = details.ranks.get(data.user_id);

    return NextResponse.json({
      herzie: formatProfile(
        data,
        canSeeListening,
        details.topArtists.get(data.user_id) ?? [],
        details.lastPlayed.get(data.user_id) ?? null,
        rank?.globalRank,
        rank?.globalTotal,
        songHuntWins,
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
      "user_id, name, friend_code, stage, level, currency, appearance, equipped, now_playing",
    )
    .in("friend_code", codes);

  if (error || !data) {
    return NextResponse.json({ herzies: [] });
  }

  const details = await fetchBatchDetails(
    admin,
    data.map((row) => row.user_id),
    data
      .filter((row) => visibleCodes.has(row.friend_code))
      .map((row) => row.user_id),
  );

  // Still per row, but only for herzies wearing the Good Eye Sniper, which is
  // rare enough not to be worth its own batch RPC.
  const songHuntWinsByUser = new Map<string, number | undefined>();
  await Promise.all(
    data
      .filter((row) =>
        hasGoodEyeSniperEquipped(normalizeEquipped(row.equipped)),
      )
      .map(async (row) => {
        songHuntWinsByUser.set(
          row.user_id,
          await getSongHuntWins(admin, row.user_id),
        );
      }),
  );

  const herzies = data.map((row) => {
    const rank = details.ranks.get(row.user_id);
    return formatProfile(
      row,
      visibleCodes.has(row.friend_code),
      details.topArtists.get(row.user_id) ?? [],
      details.lastPlayed.get(row.user_id) ?? null,
      rank?.globalRank,
      rank?.globalTotal,
      songHuntWinsByUser.get(row.user_id),
    );
  });

  return NextResponse.json({ herzies });
}

type HerzieRow = {
  user_id: string;
  name: string;
  friend_code: string;
  stage: number;
  level: number;
  currency: number | null;
  appearance: unknown;
  equipped: unknown;
  now_playing: {
    title?: string;
    artist?: string;
    albumArtUrl?: string;
  } | null;
};

function formatNowPlaying(
  np: { title?: string; artist?: string; albumArtUrl?: string } | null,
): { title: string; artist: string; albumArtUrl?: string } | null {
  if (!np?.title || !np?.artist) return null;
  return { title: np.title, artist: np.artist, albumArtUrl: np.albumArtUrl };
}

function formatProfile(
  row: HerzieRow,
  canSeeListening: boolean,
  topArtists: { name: string; plays: number }[],
  lastPlayed: {
    title: string;
    artist: string;
    listenedAt: string;
    albumArtUrl?: string;
  } | null,
  globalRank?: number,
  globalTotal?: number,
  songHuntWins?: number,
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
    equipped: normalizeEquipped(row.equipped),
    nowPlaying: canSeeListening ? formatNowPlaying(row.now_playing) : null,
    lastPlayed: canSeeListening ? lastPlayed : null,
    songHuntWins,
  };
}

/** Whether the Good Eye Sniper is equipped in the modifier slot. */
function hasGoodEyeSniperEquipped(
  equipped: ReturnType<typeof normalizeEquipped>,
): boolean {
  return isModifierEquipped(equipped, "good-eye-sniper");
}

async function getSongHuntWins(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<number | undefined> {
  const { data, error } = await admin.rpc("count_song_hunt_wins", {
    p_user_id: userId,
  });
  return error ? undefined : (data as number);
}

type TopArtist = { name: string; plays: number };
type LastPlayed = {
  title: string;
  artist: string;
  listenedAt: string;
  albumArtUrl?: string;
};
type Rank = { globalRank?: number; globalTotal?: number };

/**
 * Per-request listening and ranking data for a batch of herzies.
 *
 * Everything here used to be fetched per row, which made a full friend list
 * 4xN queries — and the top-artists half paged each user's entire listen_log
 * 1000 rows at a time to tally artists in JS. These three RPCs aggregate in
 * Postgres and take the whole batch at once (see 00056_lookup_batch_rpcs.sql),
 * so the cost is three round trips regardless of how many friends are looked
 * up, and no listening history crosses the wire.
 *
 * `listeningUserIds` must contain only users whose listening data the caller
 * is allowed to see — the RPCs are service-role and do not re-check.
 */
async function fetchBatchDetails(
  admin: ReturnType<typeof createAdminClient>,
  allUserIds: string[],
  listeningUserIds: string[],
) {
  const wantsListening = listeningUserIds.length > 0;

  const [topArtistRows, lastPlayedRows, rankRows] = await Promise.all([
    wantsListening
      ? admin.rpc("top_artists_for_users", {
          p_user_ids: listeningUserIds,
          p_limit: 3,
        })
      : Promise.resolve({ data: [] }),
    wantsListening
      ? admin.rpc("last_played_for_users", { p_user_ids: listeningUserIds })
      : Promise.resolve({ data: [] }),
    admin.rpc("herzie_ranks", { p_user_ids: allUserIds }),
  ]);

  const topArtists = new Map<string, TopArtist[]>();
  // Already ordered by rank within each user by the RPC's row_number().
  for (const row of (topArtistRows.data ?? []) as {
    user_id: string;
    artist_name: string;
    plays: number;
  }[]) {
    const list = topArtists.get(row.user_id) ?? [];
    list.push({ name: row.artist_name, plays: row.plays });
    topArtists.set(row.user_id, list);
  }

  const lastPlayed = new Map<string, LastPlayed>();
  for (const row of (lastPlayedRows.data ?? []) as {
    user_id: string;
    track_name: string;
    artist_name: string;
    listened_at: string;
    album_art_url: string | null;
  }[]) {
    lastPlayed.set(row.user_id, {
      title: row.track_name,
      artist: row.artist_name,
      listenedAt: row.listened_at,
      albumArtUrl: row.album_art_url ?? undefined,
    });
  }

  const ranks = new Map<string, Rank>();
  for (const row of (rankRows.data ?? []) as {
    user_id: string;
    global_rank: number;
    global_total: number;
  }[]) {
    ranks.set(row.user_id, {
      globalRank: row.global_rank,
      globalTotal: row.global_total,
    });
  }

  return { topArtists, lastPlayed, ranks };
}
