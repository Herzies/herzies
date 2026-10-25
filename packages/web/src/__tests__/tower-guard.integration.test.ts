/**
 * Integration tests for the Tower Guard (00121): he ranks a Tower's
 * climbers by best floor (the earlier one winning a tie, and playing on
 * without climbing doesn't move you), leaves the excluded out of the
 * reward, and pays last month's winner once.
 *
 * Requires: `npx supabase start`
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
} from "./integration-helpers";

const admin = () => getAdminClient();
const HOUR = 3_600_000;

async function tower(startsIn: number, endsIn: number, config = {}) {
  const { data, error } = await admin()
    .from("events")
    .insert({
      type: "tower",
      title: "The Tower",
      active: true,
      starts_at: new Date(Date.now() + startsIn).toISOString(),
      ends_at: new Date(Date.now() + endsIn).toISOString(),
      config,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

async function player(name?: string) {
  const user = await createTestUser();
  await createTestHerzie(user.userId, name ? { name } : {});
  return user.userId;
}

async function climb(uid: string, event: string, floor: number, at: number) {
  const { error } = await admin()
    .from("tower_progress")
    .upsert({
      user_id: uid,
      event_id: event,
      best_floor: floor,
      updated_at: new Date(at).toISOString(),
    });
  if (error) throw new Error(error.message);
}

type Guard = {
  current: {
    top: { rank: number; name: string; floor: number }[];
    you: { rank: number; floor: number } | null;
  } | null;
  last: { name: string; floor: number } | null;
  reward: { eligible: boolean; itemId: string | null };
};

async function guard(uid: string) {
  const { data, error } = await admin().rpc("tower_guard_json", {
    p_user: uid,
  });
  if (error) throw new Error(error.message);
  return data as Guard;
}

async function claim(uid: string) {
  const { data, error } = await admin().rpc("claim_tower_reward", {
    p_user: uid,
  });
  if (error) throw new Error(error.message);
  return data as { ok: boolean; itemId?: string; reason?: string };
}

async function clearTowers() {
  await admin().from("events").delete().eq("type", "tower");
}

describe("the Tower Guard", () => {
  beforeEach(clearTowers);
  afterAll(async () => {
    await clearTowers();
    await cleanupTestData();
  });

  it("shows this month's top three and where you stand", async () => {
    const now = await tower(-HOUR, HOUR);
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await player());
    for (const [i, uid] of ids.entries())
      await climb(uid, now, 10 - i, Date.now() - HOUR / 2);
    const g = await guard(ids[4]);
    expect(g.current?.top.map((p) => p.floor)).toEqual([10, 9, 8]);
    expect(g.current?.you).toEqual({ rank: 5, floor: 6 });
    expect(g.last).toBeNull();
    expect(g.reward.eligible).toBe(false);
  });

  it("pays last Tower's winner once, the earlier one winning a tie", async () => {
    const last = await tower(-40 * 24 * HOUR, -HOUR, {
      topRewardItemId: "power-dice-3",
      excludeHerzies: [],
    });
    const first = await player();
    const second = await player();
    await climb(second, last, 12, Date.now() - 2 * HOUR);
    await climb(first, last, 12, Date.now() - 3 * HOUR);

    expect((await guard(second)).reward.eligible).toBe(false);
    const g = await guard(first);
    expect(g.reward).toMatchObject({ eligible: true, itemId: "power-dice-3" });
    expect(g.last?.floor).toBe(12);

    expect(await claim(first)).toMatchObject({
      ok: true,
      itemId: "power-dice-3",
    });
    expect(await claim(first)).toMatchObject({
      ok: false,
      reason: "nothing-to-claim",
    });
    const { count } = await admin()
      .from("item_units")
      .select("id", { count: "exact", head: true })
      .eq("user_id", first)
      .eq("item_id", "power-dice-3");
    expect(count).toBe(1);
    expect((await guard(first)).reward.eligible).toBe(false);
  });

  it("pays nothing for a Tower with no reward set", async () => {
    const last = await tower(-40 * 24 * HOUR, -HOUR);
    const uid = await player();
    await climb(uid, last, 9, Date.now() - 3 * HOUR);
    expect((await guard(uid)).reward.eligible).toBe(false);
    expect(await claim(uid)).toMatchObject({ ok: false });
  });

  it("leaves the excluded out of the reward, but on the board", async () => {
    const name = `Owner-${Date.now()}`;
    const last = await tower(-40 * 24 * HOUR, -HOUR, {
      topRewardItemId: "power-dice-3",
      excludeHerzies: [name],
    });
    const owner = await player(name);
    const other = await player();
    await climb(owner, last, 50, Date.now() - 3 * HOUR);
    await climb(other, last, 4, Date.now() - 2 * HOUR);
    expect((await guard(owner)).reward.eligible).toBe(false);
    expect((await guard(other)).reward.eligible).toBe(true);
  });

  it("only moves a best floor's time when the floor rises", async () => {
    const now = await tower(-HOUR, HOUR);
    const uid = await player();
    const grant = (batch: string, cleared: number) =>
      admin().rpc("tower_grant", {
        p_user: uid,
        p_event: now,
        p_batch: `${batch}-${Date.now()}`,
        p_xp: 0,
        p_cleared: cleared,
        p_item_ids: [],
        p_xp_cap: 300,
        p_drop_cap: 12,
      });
    await grant("a", 5);
    const at = async () =>
      (
        await admin()
          .from("tower_progress")
          .select("updated_at")
          .eq("user_id", uid)
          .eq("event_id", now)
          .single()
      ).data?.updated_at as string;
    const first = await at();
    await new Promise((r) => setTimeout(r, 20));
    await grant("b", 3);
    expect(await at()).toBe(first);
    await grant("c", 6);
    expect(await at()).not.toBe(first);
  });
});
