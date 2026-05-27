import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { processSync } from "@/lib/game-server";
import type { SpotifyConnection } from "@/lib/spotify";
import { getRecentlyPlayed, getValidAccessToken } from "@/lib/spotify";
import { createAdminClient } from "@/lib/supabase-admin";

const CONCURRENCY_LIMIT = 5;

export async function GET(request: NextRequest) {
  // Verify cron secret (Vercel sets this automatically for cron routes)
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Fetch all Spotify connections
  const { data: connections, error } = await admin
    .from("spotify_connections")
    .select("*");

  if (error || !connections || connections.length === 0) {
    return NextResponse.json({ synced: 0 });
  }

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  // Process in batches to respect concurrency limit
  for (let i = 0; i < connections.length; i += CONCURRENCY_LIMIT) {
    const batch = connections.slice(i, i + CONCURRENCY_LIMIT);
    const results = await Promise.allSettled(
      batch.map((conn) => syncUser(admin, conn as SpotifyConnection)),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value === "synced") synced++;
        else skipped++;
      } else {
        errors++;
      }
    }
  }

  return NextResponse.json({ synced, skipped, errors });
}

async function syncUser(
  admin: ReturnType<typeof createAdminClient>,
  connection: SpotifyConnection,
): Promise<"synced" | "skipped"> {
  // Skip if CLI daemon is actively syncing (last sync within 2 minutes)
  const { data: herzie } = await admin
    .from("herzies")
    .select("last_synced_at")
    .eq("user_id", connection.user_id)
    .single();

  if (herzie?.last_synced_at) {
    const lastSync = new Date(herzie.last_synced_at as string).getTime();
    if (Date.now() - lastSync < 2 * 60_000) {
      return "skipped";
    }
  }

  // Get valid access token (refreshes if needed)
  const accessToken = await getValidAccessToken(connection, admin);

  // Fetch recently played tracks
  const after = connection.last_track_played_at
    ? new Date(connection.last_track_played_at).getTime()
    : Date.now() - 24 * 60 * 60_000; // Default: last 24 hours

  const tracks = await getRecentlyPlayed(accessToken, after);

  if (tracks.length === 0) {
    await admin
      .from("spotify_connections")
      .update({ last_polled_at: new Date().toISOString() })
      .eq("id", connection.id);
    return "skipped";
  }

  // Insert tracks into play log (dedup via unique constraint)
  let totalMinutes = 0;
  let latestPlayedAt = connection.last_track_played_at ?? "";

  for (const track of tracks) {
    const { error: insertError } = await admin
      .from("spotify_play_log")
      .insert({
        user_id: connection.user_id,
        spotify_track_id: track.trackId,
        played_at: track.playedAt,
        track_name: track.trackName,
        artist_name: track.artistName,
        duration_ms: track.durationMs,
      })
      // Skip duplicates
      .select()
      .single();

    if (!insertError) {
      // Only count minutes for newly inserted tracks
      totalMinutes += track.durationMs / 60_000;

      if (track.playedAt > latestPlayedAt) {
        latestPlayedAt = track.playedAt;
      }

      // Log to listen_log for stats
      await admin.from("listen_log").insert({
        user_id: connection.user_id,
        track_name: track.trackName,
        artist_name: track.artistName,
        source: "spotify",
        listened_at: track.playedAt,
      });
    }
  }

  // Credit XP if any new listening was found
  if (totalMinutes > 0) {
    await processSync(
      admin,
      connection.user_id,
      null, // no now_playing
      totalMinutes,
      ["pop"], // v1: default genre (Spotify recently-played doesn't include genre)
      { source: "spotify" },
    );
  }

  // Update connection timestamps
  await admin
    .from("spotify_connections")
    .update({
      last_polled_at: new Date().toISOString(),
      ...(latestPlayedAt ? { last_track_played_at: latestPlayedAt } : {}),
    })
    .eq("id", connection.id);

  return "synced";
}
