/**
 * Integration tests for boss damage from the cave (00102): batches apply
 * exactly once, the open boss is found for tickets, and the rewards a kill
 * put on the ground can be read back for the cave's loot drop (00105).
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

async function spawnBoss(hp: number, endsInMs = 3_600_000) {
  const { data, error } = await admin().rpc("spawn_boss_fight", {
    p_hated_genres: ["electronic"],
    p_hp: hp,
    p_ends_at: new Date(Date.now() + endsInMs).toISOString(),
    p_title: "Cave Boss",
  });
  if (error) throw new Error(error.message);
  return data as string;
}

async function player() {
  const user = await createTestUser();
  await createTestHerzie(user.userId);
  return user.userId;
}

async function batch(
  id: string,
  event: string,
  damage: { uid: string; damage: number }[],
) {
  const { data, error } = await admin().rpc("apply_boss_damage_batch", {
    p_batch: id,
    p_event: event,
    p_damage: damage,
  });
  if (error) throw new Error(error.message);
  return data as { applied: boolean; hp: number; killed: boolean };
}

async function clearBosses() {
  await admin().from("boss_state").delete().neq("hp", -1);
  await admin().from("boss_damage").delete().neq("damage", -1);
  await admin().from("boss_damage_batches").delete().neq("batch", "");
  await admin().from("pending_drops").delete().not("source_event", "is", null);
  await admin().from("events").delete().eq("type", "boss_fight");
}

describe("boss damage batches", () => {
  beforeEach(clearBosses);
  afterAll(async () => {
    await clearBosses();
    await cleanupTestData();
  });

  it("applies a batch's damage per player", async () => {
    const event = await spawnBoss(1000);
    const [a, b] = [await player(), await player()];
    const r = await batch("b1", event, [
      { uid: a, damage: 100 },
      { uid: b, damage: 250 },
    ]);
    expect(r).toEqual({ applied: true, hp: 650, killed: false });
    const { data } = await admin()
      .from("boss_damage")
      .select("user_id, damage")
      .eq("event_id", event);
    expect(
      Object.fromEntries((data ?? []).map((d) => [d.user_id, d.damage])),
    ).toEqual({ [a]: 100, [b]: 250 });
  });

  it("applies a re-sent batch only once", async () => {
    const event = await spawnBoss(1000);
    const a = await player();
    await batch("b2", event, [{ uid: a, damage: 100 }]);
    const again = await batch("b2", event, [{ uid: a, damage: 100 }]);
    expect(again).toEqual({ applied: false, hp: 900, killed: false });
  });

  it("applies the same batch once under parallel retries", async () => {
    const event = await spawnBoss(1000);
    const a = await player();
    const rs = await Promise.all(
      Array.from({ length: 8 }, () =>
        batch("b3", event, [{ uid: a, damage: 100 }]),
      ),
    );
    expect(rs.filter((r) => r.applied)).toHaveLength(1);
    const { data } = await admin()
      .from("boss_state")
      .select("hp")
      .eq("event_id", event)
      .single();
    expect(data?.hp).toBe(900);
  });

  it("kills at zero, and drops damage after", async () => {
    const event = await spawnBoss(150);
    const a = await player();
    const r = await batch("b4", event, [{ uid: a, damage: 200 }]);
    expect(r).toEqual({ applied: true, hp: 0, killed: true });
    const after = await batch("b5", event, [{ uid: a, damage: 50 }]);
    expect(after.hp).toBe(0);
    expect(after.killed).toBe(true);
  });

  it("puts the loot on the ground, held for the cave (00105)", async () => {
    const event = await spawnBoss(1000);
    const [a, b] = [await player(), await player()];
    // Only the top dealer gets the rarer item on top.
    await admin()
      .from("events")
      .update({
        config: { rewardItemId: "cd", topRewardItemId: "headphones", topCount: 1 },
      })
      .eq("id", event);
    const loot = async () =>
      (await admin().rpc("boss_loot_json", { p_event: event })).data as Record<
        string,
        { id: string; item: string }[]
      >;
    const units = async (uid: string) =>
      (
        await admin()
          .from("item_units")
          .select("id", { count: "exact", head: true })
          .eq("user_id", uid)
          .in("item_id", ["cd", "headphones"])
      ).count;

    // What a test herzie starts out owning.
    const before = await units(a);

    await batch("b7", event, [
      { uid: a, damage: 700 },
      { uid: b, damage: 300 },
    ]);
    expect(await loot()).toEqual({});
    await admin().rpc("settle_boss_fight", { p_event_id: event });

    // On the ground, not in the bank: base item first.
    const dropped = await loot();
    expect(dropped[a].map((d) => d.item)).toEqual(["cd", "headphones"]);
    expect(dropped[b].map((d) => d.item)).toEqual(["cd"]);
    expect(await units(a)).toBe(before);
    // Held for the cave: it "lands" in the future, so a spirit's sync
    // auto-collect leaves it be for now.
    const { data: rows } = await admin()
      .from("pending_drops")
      .select("dropped_at, source_event")
      .eq("user_id", a);
    for (const r of rows ?? []) {
      expect(r.source_event).toBe(event);
      expect(Date.parse(r.dropped_at)).toBeGreaterThan(Date.now() + 60_000);
    }

    // Settling again (the cron after town-vitals) drops nothing more.
    await admin().rpc("settle_boss_fight", { p_event_id: event });
    expect((await loot())[a]).toHaveLength(2);

    // Picking one up is what puts it in the bank, once.
    const first = dropped[a][0].id;
    const { data: got } = await admin().rpc("collect_pending_drop", {
      p_user_id: a,
      p_drop_id: first,
    });
    expect(got).toBe("cd");
    const { data: again } = await admin().rpc("collect_pending_drop", {
      p_user_id: a,
      p_drop_id: first,
    });
    expect(again).toBeNull();
    expect(await units(a)).toBe((before ?? 0) + 1);
    expect((await loot())[a].map((d) => d.item)).toEqual(["headphones"]);
  });

  it("one bad row doesn't lose the others", async () => {
    const event = await spawnBoss(1000);
    const a = await player();
    const r = await batch("b6", event, [
      { uid: "not-a-uuid", damage: 100 },
      { uid: a, damage: 100 },
    ]);
    expect(r.hp).toBe(900);
  });

  it("rejects an oversized or malformed batch", async () => {
    const event = await spawnBoss(1000);
    const a = await player();
    await expect(batch("", event, [{ uid: a, damage: 1 }])).rejects.toThrow();
    await expect(
      batch(
        "b7",
        event,
        Array.from({ length: 201 }, () => ({ uid: a, damage: 1 })),
      ),
    ).rejects.toThrow();
  });
});

describe("the open boss", () => {
  beforeEach(clearBosses);

  it("is the live, unkilled one with its health", async () => {
    const event = await spawnBoss(1000);
    const { data, error } = await admin().rpc("open_boss_json");
    expect(error).toBeNull();
    expect(data).toMatchObject({ event, hp: 1000, maxHp: 1000 });
    expect(data.until).toBeGreaterThan(Date.now() / 1000);
  });

  it("is nothing once killed", async () => {
    const event = await spawnBoss(10);
    const a = await player();
    await batch("k1", event, [{ uid: a, damage: 99 }]);
    const { data } = await admin().rpc("open_boss_json");
    expect(data).toBeNull();
  });

  it("is nothing when no boss is on", async () => {
    const { data } = await admin().rpc("open_boss_json");
    expect(data).toBeNull();
  });
});
