/**
 * Integration tests for the Tower (00115): the ticket's claim starts a
 * herzie one floor past their best, kill batches pay once, the daily caps
 * hold, and Tower XP waits in pending_xp for the next sync to take.
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

async function openTower(endsInMs = 3_600_000) {
  const { data, error } = await admin()
    .from("events")
    .insert({
      type: "tower",
      title: "The Tower",
      active: true,
      starts_at: new Date(Date.now() - 60_000).toISOString(),
      ends_at: new Date(Date.now() + endsInMs).toISOString(),
      config: {},
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

async function player() {
  const user = await createTestUser();
  await createTestHerzie(user.userId);
  return user.userId;
}

async function grant(
  uid: string,
  event: string,
  batch: string,
  over: Partial<{
    xp: number;
    cleared: number;
    items: string[];
    xpCap: number;
    dropCap: number;
  }> = {},
) {
  const { data, error } = await admin().rpc("tower_grant", {
    p_user: uid,
    p_event: event,
    p_batch: batch,
    p_xp: over.xp ?? 0,
    p_cleared: over.cleared ?? 0,
    p_item_ids: over.items ?? [],
    p_xp_cap: over.xpCap ?? 300,
    p_drop_cap: over.dropCap ?? 12,
  });
  if (error) throw new Error(error.message);
  return data as { drops: { id: string; item: string }[] };
}

async function claim(uid: string) {
  const { data, error } = await admin().rpc("open_tower_json", {
    p_user: uid,
  });
  if (error) throw new Error(error.message);
  return data as { event: string; until: number; floor: number } | null;
}

async function clearTowers() {
  await admin().from("tower_batches").delete().neq("batch", "");
  await admin().from("events").delete().eq("type", "tower");
}

describe("the Tower", () => {
  beforeEach(clearTowers);
  afterAll(async () => {
    await clearTowers();
    await cleanupTestData();
  });

  it("has no claim while no Tower is on", async () => {
    expect(await claim(await player())).toBeNull();
  });

  it("starts you one floor past your best", async () => {
    const event = await openTower();
    const uid = await player();
    expect(await claim(uid)).toMatchObject({ event, floor: 1 });
    await grant(uid, event, "c1", { cleared: 3 });
    await grant(uid, event, "c2", { cleared: 2 });
    expect((await claim(uid))?.floor).toBe(4);
  });

  it("pays a batch once: drops on the ground, XP pending", async () => {
    const event = await openTower();
    const uid = await player();
    const first = await grant(uid, event, "b1", {
      xp: 7,
      items: ["cd", "no-such-item", "power-dice-1"],
    });
    expect(first.drops.map((d) => d.item)).toEqual(["cd", "power-dice-1"]);
    const again = await grant(uid, event, "b1", { xp: 7, items: ["cd"] });
    expect(again.drops).toEqual([]);

    const { data: ground } = await admin()
      .from("pending_drops")
      .select("id, item_id, source_event")
      .eq("user_id", uid);
    expect(ground?.map((g) => g.item_id).sort()).toEqual([
      "cd",
      "power-dice-1",
    ]);
    expect(ground?.every((g) => g.source_event === event)).toBe(true);

    const take = async () =>
      (await admin().rpc("take_pending_xp", { p_user: uid })).data;
    expect(await take()).toBe(7);
    expect(await take()).toBeNull();
  });

  it("holds to the day's caps", async () => {
    const event = await openTower();
    const uid = await player();
    await grant(uid, event, "d1", {
      xp: 8,
      items: ["cd", "cd"],
      xpCap: 10,
      dropCap: 3,
    });
    const second = await grant(uid, event, "d2", {
      xp: 8,
      items: ["cd", "cd"],
      xpCap: 10,
      dropCap: 3,
    });
    expect(second.drops).toHaveLength(1);
    const { data } = await admin()
      .from("tower_daily")
      .select("xp, drops")
      .eq("user_id", uid)
      .single();
    expect(data).toEqual({ xp: 10, drops: 3 });
  });
});
