import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockAdmin, responseJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth", () => ({
  authenticateRequest: vi.fn(),
  isAuthError: (r: unknown) => r instanceof Response,
}));

vi.mock("@/lib/supabase-admin", () => ({
  createAdminClient: vi.fn(),
}));

import { authenticateRequest } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";
import { GET } from "./route";

const mockAuth = vi.mocked(authenticateRequest);
const mockAdmin = vi.mocked(createAdminClient);

type Profile = {
  friendCode: string;
  globalRank?: number;
  globalTotal?: number;
  topArtists: { name: string; plays: number }[];
  lastPlayed: { title: string } | null;
  nowPlaying: { title: string } | null;
};

function getRequest(codes: string): Request {
  return new Request(
    `http://localhost/api/lookup?codes=${encodeURIComponent(codes)}`,
    { headers: { Authorization: "Bearer valid-token" } },
  );
}

/**
 * The caller (HERZ-ME) is friends with HERZ-FRIEND only. HERZ-STRANGER is a
 * non-friend whose listening data must stay private.
 */
function adminWithTwoHerzies() {
  const admin = createMockAdmin(
    {},
    {
      top_artists_for_users: {
        data: [
          { user_id: "user-friend", artist_name: "Boards", plays: 9 },
          { user_id: "user-friend", artist_name: "Aphex", plays: 4 },
        ],
      },
      last_played_for_users: {
        data: [
          {
            user_id: "user-friend",
            track_name: "Roygbiv",
            artist_name: "Boards",
            listened_at: "2026-09-14T00:00:00Z",
            album_art_url: null,
          },
        ],
      },
      herzie_ranks: {
        data: [
          { user_id: "user-friend", global_rank: 2, global_total: 26 },
          { user_id: "user-stranger", global_rank: 7, global_total: 26 },
        ],
      },
    },
  );

  const originalFrom = admin.from;
  let herzieCalls = 0;
  admin.from = vi.fn((table: string) => {
    if (table !== "herzies") return originalFrom(table);
    herzieCalls++;
    const chain = originalFrom("__e__") as Record<string, unknown>;
    chain.then =
      herzieCalls === 1
        ? (resolve: (v: unknown) => void) =>
            resolve({
              data: { friend_code: "HERZ-ME", friend_codes: ["HERZ-FRIEND"] },
              error: null,
            })
        : (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                {
                  user_id: "user-friend",
                  name: "Friendly",
                  friend_code: "HERZ-FRIEND",
                  stage: 3,
                  level: 5,
                  currency: 10,
                  appearance: null,
                  equipped: null,
                  now_playing: { title: "Roygbiv", artist: "Boards" },
                },
                {
                  user_id: "user-stranger",
                  name: "Stranger",
                  friend_code: "HERZ-STRANGER",
                  stage: 2,
                  level: 3,
                  currency: 0,
                  appearance: null,
                  equipped: null,
                  now_playing: { title: "Secret", artist: "Nobody" },
                },
              ],
              error: null,
            });
    return chain;
  }) as typeof admin.from;

  return admin;
}

/** Same fixture data, but shaped for the ?code= branch's .single() call. */
function singleHerzieAdmin(friendCode: string, userId: string) {
  const admin = adminWithTwoHerzies();
  const originalFrom = admin.from;
  let herzieCalls = 0;
  admin.from = vi.fn((table: string) => {
    if (table !== "herzies") return originalFrom(table);
    herzieCalls++;
    if (herzieCalls === 1) return originalFrom(table);
    const chain = originalFrom("__e__") as Record<string, unknown>;
    chain.then = (resolve: (v: unknown) => void) =>
      resolve({
        data: {
          user_id: userId,
          name: "Someone",
          friend_code: friendCode,
          stage: 3,
          level: 5,
          currency: 0,
          appearance: null,
          equipped: null,
          now_playing: null,
        },
        error: null,
      });
    return chain;
  }) as typeof admin.from;
  return admin;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/lookup", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const res = await GET(getRequest("HERZ-FRIEND"));
    expect(res.status).toBe(401);
  });

  it("returns listening data for friends and withholds it from strangers", async () => {
    mockAuth.mockResolvedValue({ userId: "user-me" });
    mockAdmin.mockReturnValue(adminWithTwoHerzies() as never);

    const res = await GET(getRequest("HERZ-FRIEND,HERZ-STRANGER"));
    const { herzies } = (await responseJson(res)) as { herzies: Profile[] };

    const friend = herzies.find((h) => h.friendCode === "HERZ-FRIEND");
    const stranger = herzies.find((h) => h.friendCode === "HERZ-STRANGER");

    expect(friend?.topArtists).toEqual([
      { name: "Boards", plays: 9 },
      { name: "Aphex", plays: 4 },
    ]);
    expect(friend?.lastPlayed?.title).toBe("Roygbiv");
    expect(friend?.nowPlaying?.title).toBe("Roygbiv");

    expect(stranger?.topArtists).toEqual([]);
    expect(stranger?.lastPlayed).toBeNull();
    expect(stranger?.nowPlaying).toBeNull();
  });

  it("never asks the database for a stranger's listening history", async () => {
    // Stronger than the response check above: a non-friend's user_id must not
    // even reach the listening RPCs, which are service-role and do no
    // visibility check of their own.
    mockAuth.mockResolvedValue({ userId: "user-me" });
    const admin = adminWithTwoHerzies();
    mockAdmin.mockReturnValue(admin as never);

    await GET(getRequest("HERZ-FRIEND,HERZ-STRANGER"));

    for (const rpc of ["top_artists_for_users", "last_played_for_users"]) {
      const call = admin.rpc.mock.calls.find(([name]) => name === rpc);
      expect(call?.[1]).toMatchObject({ p_user_ids: ["user-friend"] });
    }
  });

  it("resolves rank per herzie rather than applying one to all", async () => {
    mockAuth.mockResolvedValue({ userId: "user-me" });
    mockAdmin.mockReturnValue(adminWithTwoHerzies() as never);

    const res = await GET(getRequest("HERZ-FRIEND,HERZ-STRANGER"));
    const { herzies } = (await responseJson(res)) as { herzies: Profile[] };

    expect(herzies.find((h) => h.friendCode === "HERZ-FRIEND")).toMatchObject({
      globalRank: 2,
      globalTotal: 26,
    });
    expect(herzies.find((h) => h.friendCode === "HERZ-STRANGER")).toMatchObject(
      {
        globalRank: 7,
        globalTotal: 26,
      },
    );
  });

  it("makes one round trip per RPC regardless of herzie count", async () => {
    mockAuth.mockResolvedValue({ userId: "user-me" });
    const admin = adminWithTwoHerzies();
    mockAdmin.mockReturnValue(admin as never);

    await GET(getRequest("HERZ-FRIEND,HERZ-STRANGER"));

    // Two herzies, three RPCs — not 4xN. No Good Eye Sniper equipped, so
    // count_song_hunt_wins is not called at all.
    expect(admin.rpc).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["HERZ-FRIEND", "user-friend", true],
    ["HERZ-STRANGER", "user-stranger", false],
  ])("single lookup of %s asks for listening data only when allowed", async (code, userId, expectListening) => {
    // ?code= is a separate branch from ?codes= and ends in .single(), so it
    // needs its own mock shape — a bare row, not an array.
    mockAuth.mockResolvedValue({ userId: "user-me" });
    const admin = singleHerzieAdmin(code, userId);
    mockAdmin.mockReturnValue(admin as never);

    const res = await GET(
      new Request(`http://localhost/api/lookup?code=${code}`, {
        headers: { Authorization: "Bearer valid-token" },
      }),
    );
    const { herzie } = (await responseJson(res)) as { herzie: Profile };

    const called = admin.rpc.mock.calls.map(([name]) => name);
    expect(called).toContain("herzie_ranks");
    expect(called.includes("top_artists_for_users")).toBe(expectListening);
    expect(herzie.lastPlayed !== null).toBe(expectListening);
    expect(herzie.globalRank).toBe(expectListening ? 2 : 7);
  });
});
