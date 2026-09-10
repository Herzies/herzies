/**
 * Integration tests for the world-drop RPCs (roll_pending_drop,
 * collect_pending_drop) against local Supabase.
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

describe("roll_pending_drop", () => {
  it("sets the pending drop when the slot is empty", async () => {
    const admin = getAdminClient();
    const { userId } = await createTestUser();
    await createTestHerzie(userId);

    await admin.rpc("roll_pending_drop", {
      p_user_id: userId,
      p_item_id: "headphones",
    });

    const { data } = await admin
      .from("herzies")
      .select("pending_drop_item_id, pending_drop_at")
      .eq("user_id", userId)
      .single();

    expect(data!.pending_drop_item_id).toBe("headphones");
    expect(data!.pending_drop_at).not.toBeNull();
  });

  it("no-ops when a drop is already pending — never overwrites", async () => {
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

    const { data } = await admin
      .from("herzies")
      .select("pending_drop_item_id")
      .eq("user_id", userId)
      .single();

    expect(data!.pending_drop_item_id).toBe("headphones");
  });
});

describe("collect_pending_drop", () => {
  it("grants the item, clears the pending state, and returns the item id", async () => {
    const admin = getAdminClient();
    const { userId } = await createTestUser();
    await createTestHerzie(userId, { inventory_v2: {} });

    await admin.rpc("roll_pending_drop", {
      p_user_id: userId,
      p_item_id: "headphones",
    });

    const { data: collected } = await admin.rpc("collect_pending_drop", {
      p_user_id: userId,
    });
    expect(collected).toBe("headphones");

    const { data } = await admin
      .from("herzies")
      .select("inventory_v2, pending_drop_item_id, pending_drop_at")
      .eq("user_id", userId)
      .single();

    expect((data!.inventory_v2 as Record<string, number>).headphones).toBe(1);
    expect(data!.pending_drop_item_id).toBeNull();
    expect(data!.pending_drop_at).toBeNull();
  });

  it("increments an existing stack rather than overwriting it", async () => {
    const admin = getAdminClient();
    const { userId } = await createTestUser();
    await createTestHerzie(userId, { inventory_v2: { cd: 2 } });

    await admin.rpc("roll_pending_drop", { p_user_id: userId, p_item_id: "cd" });
    await admin.rpc("collect_pending_drop", { p_user_id: userId });

    const { data } = await admin
      .from("herzies")
      .select("inventory_v2")
      .eq("user_id", userId)
      .single();

    expect((data!.inventory_v2 as Record<string, number>).cd).toBe(3);
  });

  it("returns null and does not grant when nothing is pending", async () => {
    const admin = getAdminClient();
    const { userId } = await createTestUser();
    await createTestHerzie(userId, { inventory_v2: {} });

    const { data: collected } = await admin.rpc("collect_pending_drop", {
      p_user_id: userId,
    });
    expect(collected).toBeNull();

    const { data } = await admin
      .from("herzies")
      .select("inventory_v2")
      .eq("user_id", userId)
      .single();
    expect(Object.keys(data!.inventory_v2 as Record<string, number>)).toHaveLength(
      0,
    );
  });

  it("a second concurrent collect is a no-op — only grants once", async () => {
    const admin = getAdminClient();
    const { userId } = await createTestUser();
    await createTestHerzie(userId, { inventory_v2: {} });

    await admin.rpc("roll_pending_drop", {
      p_user_id: userId,
      p_item_id: "headphones",
    });

    const [first, second] = await Promise.all([
      admin.rpc("collect_pending_drop", { p_user_id: userId }),
      admin.rpc("collect_pending_drop", { p_user_id: userId }),
    ]);

    const results = [first.data, second.data].sort();
    // Exactly one caller wins the row lock and collects; the other sees the
    // slot already cleared and gets null back.
    expect(results).toEqual([null, "headphones"]);

    const { data } = await admin
      .from("herzies")
      .select("inventory_v2")
      .eq("user_id", userId)
      .single();
    expect((data!.inventory_v2 as Record<string, number>).headphones).toBe(1);
  });
});
