/**
 * Integration tests for cloaks (00123): the back slot, worn from stage 3
 * by any class, and the class cloaks in a boss's random loot.
 *
 * Requires: `npx supabase start`
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
  getUnits,
} from "./integration-helpers";

const admin = () => getAdminClient();

async function player(overrides: Record<string, unknown> = {}) {
  const user = await createTestUser();
  await createTestHerzie(user.userId, overrides);
  return user.userId;
}

async function rpc<T = Record<string, unknown>>(
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await admin().rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

async function give(userId: string, itemId: string) {
  const { data } = await admin()
    .from("item_units")
    .insert({ user_id: userId, item_id: itemId })
    .select("id")
    .single();
  return data?.id as string;
}

describe("cloaks", () => {
  afterAll(cleanupTestData);

  it("wait for stage 3", async () => {
    const userId = await player({ stage: 2, level: 12 });
    const unit = await give(userId, "groove-cape");
    const r = await rpc("equip_unit", {
      p_user_id: userId,
      p_unit_id: unit,
      p_action: "equip",
    });
    expect(r).toMatchObject({ ok: false, reason: "stage-too-low" });
  });

  it("go on the back at stage 3, whatever the class", async () => {
    const userId = await player({ stage: 3, level: 30 });
    await rpc("choose_class", { p_user_id: userId, p_class: "percussionist" });
    const unit = await give(userId, "troubadour-mantle");
    const r = await rpc("equip_unit", {
      p_user_id: userId,
      p_unit_id: unit,
      p_action: "equip",
    });
    expect(r).toMatchObject({ ok: true });
    const worn = (await getUnits(userId)).find((u) => u.id === unit);
    expect(worn?.equipped_slot).toBe("back");
  });

  it("one at a time: a second swaps the first off", async () => {
    const userId = await player({ stage: 3, level: 30 });
    const first = await give(userId, "drumhide-cloak");
    const second = await give(userId, "tailwind-cloak");
    for (const unit of [first, second]) {
      await rpc("equip_unit", {
        p_user_id: userId,
        p_unit_id: unit,
        p_action: "equip",
      });
    }
    const units = await getUnits(userId);
    expect(units.find((u) => u.id === first)?.equipped_slot).toBeNull();
    expect(units.find((u) => u.id === second)?.equipped_slot).toBe("back");
  });

  it("no cloak is in a boss's random loot (they come from reward pools)", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1500; i++) {
      seen.add(await rpc<string>("boss_loot_roll", {}));
    }
    for (const id of [
      "troubadour-mantle",
      "groove-cape",
      "drumhide-cloak",
      "tailwind-cloak",
    ]) {
      expect(seen.has(id)).toBe(false);
    }
  }, 120_000);
});
