/**
 * Integration tests for the stats on a looked-up profile.
 * Requires: `npx supabase start`.
 *
 * Stats are game data, not listening data, so unlike now-playing and top
 * artists they come back for anyone — friend or stranger — and include the
 * dice-upgrade levels the client can't see on someone else's profile.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as lookup } from "@/app/api/lookup/route";
import {
  authenticatedRequest,
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  setLocalEnv,
} from "./integration-helpers";

beforeAll(() => {
  setLocalEnv();
});

afterAll(async () => {
  await cleanupTestData();
}, 15000);

const look = async (viewerToken: string, friendCode: string) => {
  const res = await lookup(
    authenticatedRequest(
      `/lookup?code=${friendCode}`,
      viewerToken,
      undefined,
      "GET",
    ),
  );
  return (await res.json()).herzie;
};

describe("lookup stats", () => {
  it("sums equipped items, counting each upgrade level, for a stranger", async () => {
    const owner = await createTestUser();
    const ownerHerzie = await createTestHerzie(owner.userId, {
      inventory_v2: { headphones: 1, "first-edition": 1 },
      // headphones: sonicPower 5, worn at +2 -> 7. first-edition: luck 10.
      equipped: { head: "headphones", modifier: ["first-edition"] },
      item_upgrades: { headphones: 2 },
    });
    const stranger = await createTestUser();
    await createTestHerzie(stranger.userId);

    const profile = await look(
      stranger.accessToken,
      ownerHerzie.friend_code as string,
    );

    expect(profile.stats).toEqual({ sonicPower: 7, luck: 10 });
    // Listening data stays private to non-friends; stats do not.
    expect(profile.topArtists).toEqual([]);
    expect(profile.nowPlaying).toBeNull();
  });

  it("is all zero for a herzie wearing nothing that has stats", async () => {
    const owner = await createTestUser();
    const ownerHerzie = await createTestHerzie(owner.userId, {
      inventory_v2: { cd: 1 },
    });
    const profile = await look(
      owner.accessToken,
      ownerHerzie.friend_code as string,
    );
    expect(profile.stats).toEqual({ sonicPower: 0, luck: 0 });
  });
});
