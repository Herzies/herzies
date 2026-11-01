/**
 * Integration tests for quests (00130): Pip's daily "Something New" is
 * taken once a day, finishes on an artist with no earlier listen_log row
 * (credits "feat." and such don't make a known artist new), and pays
 * coins (no XP) once when turned in.
 *
 * Requires: `npx supabase start`
 */
import { PIP_KEY } from "@herzies/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as acceptRoute } from "@/app/api/quests/accept/route";
import { POST as claimRoute } from "@/app/api/quests/claim/route";
import { GET as boardRoute } from "@/app/api/quests/route";
import { POST as syncRoute } from "@/app/api/sync/route";
import {
  authenticatedRequest,
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
  setLocalEnv,
} from "./integration-helpers";

const admin = () => getAdminClient();
let user: { userId: string; accessToken: string };

beforeEach(async () => {
  setLocalEnv();
  user = await createTestUser();
  await createTestHerzie(user.userId);
}, 10000);

afterAll(async () => {
  await cleanupTestData();
}, 10000);

async function board() {
  const res = await boardRoute(
    authenticatedRequest("/quests", user.accessToken, undefined, "GET"),
  );
  expect(res.status).toBe(200);
  return res.json();
}

async function accept() {
  return acceptRoute(
    authenticatedRequest("/quests/accept", user.accessToken, {
      giver: PIP_KEY,
    }),
  );
}

async function heard(artist: string, track = "Old Song") {
  const { error } = await admin()
    .from("listen_log")
    .insert({ user_id: user.userId, track_name: track, artist_name: artist });
  if (error) throw new Error(error.message);
}

async function play(title: string, artist: string) {
  // Past the billing cooldown, so every call is a real sync.
  await admin()
    .from("herzies")
    .update({
      last_synced_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    })
    .eq("user_id", user.userId);
  const res = await syncRoute(
    authenticatedRequest("/sync", user.accessToken, {
      nowPlaying: { title, artist },
      minutesListened: 1,
      genres: [],
    }),
  );
  expect(res.status).toBe(200);
  return res.json() as Promise<{
    notifications: { title: string; message: string }[];
  }>;
}

const pipQuest = async () =>
  (await board()).quests.find((q: { giver: string }) => q.giver === PIP_KEY);

describe("Quests", () => {
  it("offers Pip's quest, and takes it once a day", async () => {
    const before = await board();
    expect(before.offers[PIP_KEY]?.id).toBe("pip_new_artist");
    expect(before.quests).toEqual([]);

    const res = await accept();
    expect(res.status).toBe(200);
    const after = await board();
    expect(after.offers[PIP_KEY]).toBeNull();
    expect(after.quests).toHaveLength(1);
    expect(after.quests[0]).toMatchObject({
      giver: PIP_KEY,
      giverName: "Pip",
      title: "Something New",
      progress: 0,
      target: 1,
      status: "active",
    });

    const again = await accept();
    expect(again.status).toBe(409);
  });

  it("doesn't count an artist you've heard, even credited differently", async () => {
    await heard("Daft Punk feat. Pharrell Williams");
    await accept();

    const res = await play("One More Time (Remastered)", "Daft Punk");
    expect(res.notifications.some((n) => n.title === "Quest complete")).toBe(
      false,
    );
    expect((await pipQuest()).progress).toBe(0);
  });

  it("finishes on a new artist, and pays once on turn-in", async () => {
    await heard("Queen");
    await accept();

    const res = await play("Windowlicker", "Aphex Twin");
    const done = res.notifications.find((n) => n.title === "Quest complete");
    expect(done?.message).toContain('"Something New"');
    expect(done?.message).toContain("Pip");

    const quest = await pipQuest();
    expect(quest).toMatchObject({ progress: 1, status: "complete" });
    // Still holding a finished one: nothing new on offer.
    expect((await board()).offers[PIP_KEY]).toBeNull();

    const { data: before } = await admin()
      .from("herzies")
      .select("currency, pending_xp")
      .eq("user_id", user.userId)
      .single();

    const claim = await claimRoute(
      authenticatedRequest("/quests/claim", user.accessToken, {
        id: quest.id,
      }),
    );
    expect(claim.status).toBe(200);
    const body = await claim.json();
    expect(body.reward).toEqual({ coins: 500 });
    expect(body.newCurrency).toBe((before?.currency ?? 0) + 500);

    const { data: after } = await admin()
      .from("herzies")
      .select("currency, pending_xp")
      .eq("user_id", user.userId)
      .single();
    expect(after?.currency).toBe((before?.currency ?? 0) + 500);
    // Quests pay coins only.
    expect(Number(after?.pending_xp)).toBe(Number(before?.pending_xp));

    const twice = await claimRoute(
      authenticatedRequest("/quests/claim", user.accessToken, {
        id: quest.id,
      }),
    );
    expect(twice.status).toBe(409);
    expect((await pipQuest()).status).toBe("claimed");
  });

  it("won't turn in a quest that isn't finished", async () => {
    await accept();
    const quest = await pipQuest();
    const res = await claimRoute(
      authenticatedRequest("/quests/claim", user.accessToken, {
        id: quest.id,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("lets yesterday's unfinished quest lapse, but keeps a finished one", async () => {
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    await admin().from("user_quests").insert({
      user_id: user.userId,
      giver: PIP_KEY,
      quest_id: "pip_new_artist",
      title: "Something New",
      kind: "new_artist",
      day: yesterday,
      target: 1,
    });

    // Lapsed: not shown, today's is on offer, and a new artist doesn't
    // move it.
    let b = await board();
    expect(b.quests).toEqual([]);
    expect(b.offers[PIP_KEY]?.id).toBe("pip_new_artist");
    await play("Teardrop", "Massive Attack");
    const { data: row } = await admin()
      .from("user_quests")
      .select("progress, status")
      .eq("user_id", user.userId)
      .eq("day", yesterday)
      .single();
    expect(row).toEqual({ progress: 0, status: "active" });

    // Finished yesterday and never turned in: still there, and it has to go
    // in before today's.
    await admin()
      .from("user_quests")
      .update({ progress: 1, status: "complete" })
      .eq("user_id", user.userId)
      .eq("day", yesterday);
    b = await board();
    expect(b.quests).toHaveLength(1);
    expect(b.quests[0].status).toBe("complete");
    expect(b.offers[PIP_KEY]).toBeNull();
    expect((await accept()).status).toBe(409);
  });
});
