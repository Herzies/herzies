/**
 * Integration tests for stat points (00108): the allocation's limits, a
 * reset, and Stamina's max HP.
 *
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
  setLocalEnv,
} from "./integration-helpers";

beforeAll(() => {
  setLocalEnv();
});

const admin = () => getAdminClient();

async function player(level = 1) {
  const user = await createTestUser();
  await createTestHerzie(user.userId, { level });
  return user;
}

async function rpc<T = Record<string, unknown>>(
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await admin().rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

type Vitals = { hp: number; maxHp: number; stored: number | null };
type Allocated = {
  ok: boolean;
  reason?: string;
  statPoints?: { stamina: number; sonicPower: number; euphony: number };
  vitals?: Vitals;
};

const allocate = (
  userId: string,
  stamina: number,
  sonic: number,
  euphony: number,
) =>
  rpc<Allocated>("allocate_stats", {
    p_user: userId,
    p_stamina: stamina,
    p_sonic: sonic,
    p_euphony: euphony,
  });

describe("stat points", () => {
  afterAll(cleanupTestData);

  it("spends up to two points a level after the first", async () => {
    const { userId } = await player(10);
    const r = await allocate(userId, 10, 5, 3);
    expect(r.ok).toBe(true);
    expect(r.statPoints).toEqual({ stamina: 10, sonicPower: 5, euphony: 3 });
    const { data } = await admin()
      .from("herzies")
      .select("stat_stamina, stat_sonic, stat_euphony")
      .eq("user_id", userId)
      .single();
    expect(data).toEqual({ stat_stamina: 10, stat_sonic: 5, stat_euphony: 3 });
  });

  it("refuses more than the level allows, and negatives", async () => {
    const { userId } = await player(10);
    expect(await allocate(userId, 15, 4, 0)).toMatchObject({
      ok: false,
      reason: "too-many",
    });
    expect(await allocate(userId, -1, 0, 0)).toMatchObject({
      ok: false,
      reason: "bad-points",
    });
  });

  it("Stamina raises max HP, in the vitals too", async () => {
    const { userId } = await player(10); // 150 max with no points
    const r = await allocate(userId, 18, 0, 0);
    expect(r.vitals?.maxHp).toBe(330);
    const v = await rpc<Vitals>("herzie_vitals", { p_user: userId });
    expect(v).toMatchObject({ hp: 330, maxHp: 330 });
  });

  it("a reset refunds everything and brings HP down to the new max", async () => {
    const { userId } = await player(10);
    await allocate(userId, 18, 0, 0);
    await rpc("set_herzie_hp", { p_user: userId, p_hp: 300 });
    const r = await allocate(userId, 0, 0, 0);
    expect(r.ok).toBe(true);
    expect(r.statPoints).toEqual({ stamina: 0, sonicPower: 0, euphony: 0 });
    expect(r.vitals?.maxHp).toBe(150);
    expect(r.vitals?.stored).toBe(150);
    expect(r.vitals?.hp).toBeLessThanOrEqual(150);
  });

  it("respawn and rest read the Stamina max", async () => {
    const { userId } = await player(10);
    await allocate(userId, 10, 0, 0); // 250 max
    await rpc("set_herzie_hp", { p_user: userId, p_hp: 0 });
    const v = await rpc<Vitals>("respawn_herzie", { p_user: userId });
    expect(v.maxHp).toBe(250);
    expect(v.stored).toBe(125);
  });

  it("a level-1 herzie has nothing to spend", async () => {
    const { userId } = await player(1);
    expect(await allocate(userId, 1, 0, 0)).toMatchObject({
      ok: false,
      reason: "too-many",
    });
  });

  it("a sync carries the points back and never writes them", async () => {
    const user = await player(10);
    await allocate(user.userId, 2, 4, 1);
    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: null,
        minutesListened: 0,
        genres: [],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.herzie.statPoints).toEqual({
      stamina: 2,
      sonicPower: 4,
      euphony: 1,
    });
    const { data } = await admin()
      .from("herzies")
      .select("stat_stamina, stat_sonic, stat_euphony")
      .eq("user_id", user.userId)
      .single();
    expect(data).toEqual({ stat_stamina: 2, stat_sonic: 4, stat_euphony: 1 });
  });
});
