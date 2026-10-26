/**
 * The Tower boards: all time (best floor in any Tower) and this month (best
 * floor in the running Tower — the monthly one, 00120 — as the Tower Guard
 * ranks it).
 *
 * Requires: `npx supabase start`
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as leaderboard } from "@/app/api/leaderboard/route";
import {
  authenticatedRequest,
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
  setLocalEnv,
} from "./integration-helpers";

type Entry = { rank: number; name: string; towerFloor?: number };

async function board(token: string, name: string): Promise<Entry[]> {
  const res = await leaderboard(
    authenticatedRequest(`/leaderboard?board=${name}`, token, undefined, "GET"),
  );
  return ((await res.json()) as { entries: Entry[] }).entries;
}

async function tower(startsAt: Date, endsAt: Date): Promise<string> {
  const { data, error } = await getAdminClient()
    .from("events")
    .insert({
      type: "tower",
      title: "Tower",
      active: true,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      config: {},
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message);
  return data.id as string;
}

async function climbed(userId: string, eventId: string, floor: number) {
  const { error } = await getAdminClient()
    .from("tower_progress")
    .insert({ user_id: userId, event_id: eventId, best_floor: floor });
  if (error) throw new Error(error.message);
}

beforeEach(async () => {
  setLocalEnv();
  await cleanupTestData();
});

afterAll(async () => {
  await cleanupTestData();
});

describe("tower boards", () => {
  it("ranks all time across every Tower, this month only this month's", async () => {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const lastMonth = await tower(
      new Date(Date.UTC(y, m - 1, 1)),
      new Date(Date.UTC(y, m, 1)),
    );
    const thisMonth = await tower(
      new Date(Date.UTC(y, m, 1)),
      new Date(Date.UTC(y, m + 1, 1)),
    );
    // A one-off Tower that started this month and is already over: all time
    // only, like the Tower Guard.
    const oneOff = await tower(
      new Date(Date.UTC(y, m, 1)),
      new Date(now.getTime() - 1000),
    );

    const a = await createTestUser();
    const b = await createTestUser();
    const herzieA = await createTestHerzie(a.userId);
    const herzieB = await createTestHerzie(b.userId);
    const names = new Set([herzieA.name, herzieB.name]);

    await climbed(a.userId, lastMonth, 10);
    await climbed(a.userId, thisMonth, 3);
    await climbed(b.userId, thisMonth, 5);
    await climbed(b.userId, oneOff, 20);

    const ours = (entries: Entry[]) =>
      entries
        .filter((e) => names.has(e.name))
        .map((e) => [e.name, e.towerFloor]);

    expect(ours(await board(a.accessToken, "tower"))).toEqual([
      [herzieB.name, 20],
      [herzieA.name, 10],
    ]);
    expect(ours(await board(a.accessToken, "tower_month"))).toEqual([
      [herzieB.name, 5],
      [herzieA.name, 3],
    ]);
  });
});
