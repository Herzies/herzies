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

  it("anon client cannot read another user's listen_log (private)", async () => {
    const anon = getAnonClient();

    const { data, error } = await anon
      .from("listen_log")
      .select("track_name, artist_name, listened_at")
      .eq("user_id", user.userId)
      .order("listened_at", { ascending: false })
      .limit(3);

    // Listening history is private — RLS hides every row from anon. Either the
    // request errors (permission denied) or it returns no rows.
    if (error) {
      expect(error).not.toBeNull();
    } else {
      expect(data).toEqual([]);
    }
  });

  it("the owner can read their own listen_log", async () => {
    const anon = getAnonClient();
    await anon.auth.setSession({
      access_token: user.accessToken,
      refresh_token: "",
    });

    const { data, error } = await anon
      .from("listen_log")
      .select("track_name, artist_name, listened_at")
      .eq("user_id", user.userId)
      .order("listened_at", { ascending: false })
      .limit(3);

    await anon.auth.signOut();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBe(3);
    // Most recent first
    expect(data![0].track_name).toBe("Bohemian Rhapsody");
    expect(data![1].track_name).toBe("Stairway to Heaven");
    expect(data![2].track_name).toBe("Bohemian Rhapsody");
  });
});

describe("Herzies column privacy", () => {
  it("anon can read public leaderboard columns", async () => {
    const anon = getAnonClient();
    const { data, error } = await anon
      .from("herzies")
      .select("name, level, stage, total_minutes_listened")
      .eq("user_id", user.userId);

    expect(error).toBeNull();
    expect((data ?? []).length).toBe(1);
  });

  it("anon cannot read now_playing", async () => {
    const anon = getAnonClient();
    const { error } = await anon
      .from("herzies")
      .select("now_playing")
      .eq("user_id", user.userId);

    // now_playing is not granted to anon — selecting it is denied.
    expect(error).not.toBeNull();
  });
});
