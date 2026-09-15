/**
 * Integration tests for the world-drop RPCs (roll_pending_drop,
 * roll_pending_drops, collect_pending_drop) against local Supabase.
 * Requires: `npx supabase start`
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
  setLocalEnv,
} from "./integration-helpers";

beforeAll(() => {
  setLocalEnv();
}, 10000);

afterAll(async () => {
  await cleanupTestData();
}, 10000);

/** The pending drops standing on a user's ground, oldest first. */
async function groundDrops(userId: string) {
  const { data } = await getAdminClient()
    .from("pending_drops")
    .select("id, item_id")
    .eq("user_id", userId)
    .order("dropped_at", { ascending: true });
  return (data ?? []) as { id: string; item_id: string }[];
}

describe("roll_pending_drop", () => {
  it("adds a drop to the ground", async () => {
    const admin = getAdminClient();
    const { userId } = await createTestUser();
    await createTestHerzie(userId);

    await admin.rpc("roll_pending_drop", {
      p_user_id: userId,
      p_item_id: "headphones",
    });

    expect(await groundDrops(userId)).toEqual([
      expect.objectContaining({ item_id: "headphones" }),
    ]);
  });

  // The pre-00054 single-slot version no-op'd while a drop was uncollected, so
  // a drop earned while an earlier one sat on the ground was lost outright.
  it("accumulates rather than blocking on an uncollected drop", async () => {
    const admin = getAdminClient();
    const { userId } = await createTestUser();
    await createTestHerzie(userId);

    await admin.rpc("roll_pending_drop", {
      p_user_id: userId,
      p_item_id: "headphones",
    });
    await admin.rpc("roll_pending_drop", {
      p_user_id: userId,
      p_item_id: "boombox",
    });

    expect((await groundDrops(userId)).map((d) => d.item_id)).toEqual([
      "headphones",
      "boombox",
    ]);
  });
});

describe("roll_pending_drops", () => {
  it("inserts one row per item id in a single call", async () => {
    const admin = getAdminClient();
    const { userId } = await createTestUser();
    await createTestHerzie(userId);

    await admin.rpc("roll_pending_drops", {
      p_user_id: userId,
      p_item_ids: ["cd", "cd", "headphones"],
    });

    // Duplicates are separate drops, not a stack — each is picked up on its own.
    expect((await groundDrops(userId)).map((d) => d.item_id).sort()).toEqual([
      "cd",
      "cd",
      "headphones",
    ]);
  });

  it("inserts nothing for an empty array", async () => {
    const admin = getAdminClient();
    const { userId } = await createTestUser();
    await createTestHerzie(userId);

    await admin.rpc("roll_pending_drops", {
      p_user_id: userId,
      p_item_ids: [],
    });

    expect(await groundDrops(userId)).toEqual([]);
  });
});

describe("collect_pending_drop", () => {
  it("grants the item, removes the drop, and returns the item id", async () => {
    const admin = getAdminClient();
    const { userId } = await createTestUser();
    await createTestHerzie(userId, { inventory_v2: {} });

    await admin.rpc("roll_pending_drop", {
      p_user_id: userId,
      p_item_id: "headphones",
    });
    const [drop] = await groundDrops(userId);

    const { data: collected } = await admin.rpc("collect_pending_drop", {
      p_user_id: userId,
      p_drop_id: drop.id,
    });
    expect(collected).toBe("headphones");

    const { data } = await admin
      .from("herzies")
      .select("inventory_v2")
      .eq("user_id", userId)
      .single();

    expect((data!.inventory_v2 as Record<string, number>).headphones).toBe(1);
    expect(await groundDrops(userId)).toEqual([]);
  });

  it("increments an existing stack rather than overwriting it", async () => {
    const admin = getAdminClient();
    const { userId } = await createTestUser();
    await createTestHerzie(userId, { inventory_v2: { cd: 2 } });

    await admin.rpc("roll_pending_drop", {
      p_user_id: userId,
      p_item_id: "cd",
    });
    const [drop] = await groundDrops(userId);
    await admin.rpc("collect_pending_drop", {
      p_user_id: userId,
      p_drop_id: drop.id,
    });

    const { data } = await admin
      .from("herzies")
      .select("inventory_v2")
      .eq("user_id", userId)
      .single();

    expect((data!.inventory_v2 as Record<string, number>).cd).toBe(3);
  });

  it("collects only the drop named by id, leaving the rest on the ground", async () => {
    const admin = getAdminClient();
    const { userId } = await createTestUser();
    await createTestHerzie(userId, { inventory_v2: {} });

    await admin.rpc("roll_pending_drops", {
      p_user_id: userId,
      p_item_ids: ["headphones", "boombox"],
    });
    const drops = await groundDrops(userId);
    const boombox = drops.find((d) => d.item_id === "boombox")!;

    const { data: collected } = await admin.rpc("collect_pending_drop", {
      p_user_id: userId,
      p_drop_id: boombox.id,
    });
    expect(collected).toBe("boombox");

    expect((await groundDrops(userId)).map((d) => d.item_id)).toEqual([
      "headphones",
    ]);
  });

  it("returns null and does not grant when the drop does not exist", async () => {
    const admin = getAdminClient();
    const { userId } = await createTestUser();
    await createTestHerzie(userId, { inventory_v2: {} });

    const { data: collected } = await admin.rpc("collect_pending_drop", {
      p_user_id: userId,
      p_drop_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(collected).toBeNull();

    const { data } = await admin
      .from("herzies")
      .select("inventory_v2")
      .eq("user_id", userId)
      .single();
    expect(
      Object.keys(data!.inventory_v2 as Record<string, number>),
    ).toHaveLength(0);
  });

  it("does not collect another user's drop", async () => {
    const admin = getAdminClient();
    const owner = await createTestUser();
    const thief = await createTestUser();
    await createTestHerzie(owner.userId, { inventory_v2: {} });
    await createTestHerzie(thief.userId, { inventory_v2: {} });

    await admin.rpc("roll_pending_drop", {
      p_user_id: owner.userId,
      p_item_id: "headphones",
    });
    const [drop] = await groundDrops(owner.userId);

    const { data: collected } = await admin.rpc("collect_pending_drop", {
      p_user_id: thief.userId,
      p_drop_id: drop.id,
    });
    expect(collected).toBeNull();
    expect(await groundDrops(owner.userId)).toHaveLength(1);
  });

  // Racing collects are real: a Spirit Orb auto-collect during a sync can land
  // at the same moment as a click on the ground.
  it("a second concurrent collect of the same drop is a no-op", async () => {
    const admin = getAdminClient();
    const { userId } = await createTestUser();
    await createTestHerzie(userId, { inventory_v2: {} });

    await admin.rpc("roll_pending_drop", {
      p_user_id: userId,
      p_item_id: "headphones",
    });
    const [drop] = await groundDrops(userId);

    const [first, second] = await Promise.all([
      admin.rpc("collect_pending_drop", {
        p_user_id: userId,
        p_drop_id: drop.id,
      }),
      admin.rpc("collect_pending_drop", {
        p_user_id: userId,
        p_drop_id: drop.id,
      }),
    ]);

    // Exactly one caller wins the DELETE … RETURNING; the other sees the row
    // already gone and gets null back. Either may win, so assert the pair
    // rather than an order.
    const results = [first.data, second.data];
    expect(results).toContain("headphones");
    expect(results).toContain(null);

    const { data } = await admin
      .from("herzies")
      .select("inventory_v2")
      .eq("user_id", userId)
      .single();
    expect((data!.inventory_v2 as Record<string, number>).headphones).toBe(1);
  });
});
