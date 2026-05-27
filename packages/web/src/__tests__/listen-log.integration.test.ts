/**
 * Integration tests for listen_log — tracks what users listen to.
 * Requires: `npx supabase start`
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as syncRoute } from "@/app/api/sync/route";
import {
  authenticatedRequest,
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
  getAnonClient,
  setLocalEnv,
} from "./integration-helpers";

let user: { userId: string; accessToken: string };

beforeAll(async () => {
  setLocalEnv();
  user = await createTestUser();
  await createTestHerzie(user.userId);
}, 10000);

afterAll(async () => {
  const admin = getAdminClient();
  await admin
    .from("listen_log")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  await cleanupTestData();
}, 10000);

async function getListenLog(userId: string) {
  const admin = getAdminClient();
  const { data } = await admin
    .from("listen_log")
    .select("*")
    .eq("user_id", userId)
    .order("listened_at", { ascending: true });
  return data ?? [];
}

async function backdateLastSync(userId: string) {
  const admin = getAdminClient();
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  await admin
    .from("herzies")
    .update({ last_synced_at: tenMinAgo })
    .eq("user_id", userId);
}

describe("Listen log", () => {
  it("logs a track when nowPlaying is sent", async () => {
    await backdateLastSync(user.userId);

    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: {
          title: "Bohemian Rhapsody",
          artist: "Queen",
          genre: "rock",
        },
        minutesListened: 3,
        genres: ["rock"],
      }),
    );
    expect(res.status).toBe(200);

    const logs = await getListenLog(user.userId);
    expect(logs.length).toBe(1);
    expect(logs[0].track_name).toBe("Bohemian Rhapsody");
    expect(logs[0].artist_name).toBe("Queen");
    expect(logs[0].source).toBe("cli");
  });

  it("does not log again if the same track is still playing", async () => {
    await backdateLastSync(user.userId);

    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: {
          title: "Bohemian Rhapsody",
          artist: "Queen",
          genre: "rock",
        },
        minutesListened: 3,
        genres: ["rock"],
      }),
    );
    expect(res.status).toBe(200);

    const logs = await getListenLog(user.userId);
    // Still 1 — same track, no new entry
    expect(logs.length).toBe(1);
  });

  it("logs a new entry when the track changes", async () => {
    await backdateLastSync(user.userId);

    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: {
          title: "Stairway to Heaven",
          artist: "Led Zeppelin",
          genre: "rock",
        },
        minutesListened: 3,
        genres: ["rock"],
      }),
    );
    expect(res.status).toBe(200);

    const logs = await getListenLog(user.userId);
    expect(logs.length).toBe(2);
    expect(logs[1].track_name).toBe("Stairway to Heaven");
    expect(logs[1].artist_name).toBe("Led Zeppelin");
  });

  it("logs another entry when switching back to a previous track", async () => {
    await backdateLastSync(user.userId);

    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: {
          title: "Bohemian Rhapsody",
          artist: "Queen",
          genre: "rock",
        },
        minutesListened: 3,
        genres: ["rock"],
      }),
    );
    expect(res.status).toBe(200);

    const logs = await getListenLog(user.userId);
    // Should be 3: Bohemian → Stairway → Bohemian again
    expect(logs.length).toBe(3);
    expect(logs[2].track_name).toBe("Bohemian Rhapsody");
  });

  it("does not log when nowPlaying is null", async () => {
    await backdateLastSync(user.userId);

    // Clear the now_playing first so next sync has null
    const admin = getAdminClient();
    await admin
      .from("herzies")
      .update({ now_playing: null })
      .eq("user_id", user.userId);

    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: null,
        minutesListened: 0,
        genres: [],
      }),
    );
    expect(res.status).toBe(200);

    const logs = await getListenLog(user.userId);
    // Still 3 — no new entry for null
    expect(logs.length).toBe(3);
  });

  it("RLS prevents anon inserts", async () => {
    const anon = getAnonClient();

    const { error } = await anon.from("listen_log").insert({
      user_id: user.userId,
      track_name: "Hacked",
      artist_name: "Hacker",
    });

    // Should fail — anon role can't insert
    expect(error).not.toBeNull();
  });

  it("anon client can read listen_log (public SELECT policy)", async () => {
    const anon = getAnonClient();

    const { data, error } = await anon
      .from("listen_log")
      .select("track_name, artist_name, listened_at")
      .eq("user_id", user.userId)
      .order("listened_at", { ascending: false })
      .limit(3);

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBe(3);
    // Most recent first
    expect(data![0].track_name).toBe("Bohemian Rhapsody");
    expect(data![1].track_name).toBe("Stairway to Heaven");
    expect(data![2].track_name).toBe("Bohemian Rhapsody");
  });

  it("anon client can query top artists by play count", async () => {
    const anon = getAnonClient();

    // Insert extra plays via admin to create a clear ranking
    const admin = getAdminClient();
    for (let i = 0; i < 5; i++) {
      await admin.from("listen_log").insert({
        user_id: user.userId,
        track_name: `Song ${i}`,
        artist_name: "The Beatles",
        source: "cli",
      });
    }

    // Query: count plays grouped by artist, ordered by count desc
    // Supabase doesn't support group-by directly, so we fetch all and aggregate client-side
    // (or use an RPC — but for now, fetch recent and aggregate)
    const { data, error } = await anon
      .from("listen_log")
      .select("artist_name")
      .eq("user_id", user.userId);

    expect(error).toBeNull();
    expect(data).not.toBeNull();

    // Aggregate by artist
    const counts: Record<string, number> = {};
    for (const row of data!) {
      counts[row.artist_name] = (counts[row.artist_name] ?? 0) + 1;
    }

    const sorted = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    // The Beatles should be #1 with 5 plays
    expect(sorted[0][0]).toBe("The Beatles");
    expect(sorted[0][1]).toBe(5);
    // Queen should be #2 with 2 plays (from earlier tests)
    expect(sorted[1][0]).toBe("Queen");
    expect(sorted[1][1]).toBe(2);
  });
});
