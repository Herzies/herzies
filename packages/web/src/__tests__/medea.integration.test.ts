/**
 * Integration tests for Medea and Star Candy (00113): buying from the
 * always-on sweet seller, and eating a consumable to heal.
 *
 * Requires: `npx supabase start`
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as eatRoute } from "@/app/api/inventory/eat/route";
import { POST as buyRoute } from "@/app/api/npc/medea/buy/route";
import {
  authenticatedRequest,
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
  getUnits,
  setLocalEnv,
} from "./integration-helpers";

const admin = () => getAdminClient();

/** Level 1 with no Stamina: max HP 110. */
const MAX_HP = 110;

async function player(over: Record<string, unknown> = {}) {
  const user = await createTestUser();
  await createTestHerzie(user.userId, {
    inventory_v2: {},
    currency: 100,
    ...over,
  });
  return user;
}

/** Store HP as of now, so no regen has crept in yet. */
async function setHp(userId: string, hp: number, down = false) {
  await admin()
    .from("herzies")
    .update({ hp, hp_at: new Date().toISOString(), down })
    .eq("user_id", userId);
}

async function storedHp(userId: string) {
  const { data } = await admin()
    .from("herzies")
    .select("hp, down, currency")
    .eq("user_id", userId)
    .single();
  return data as { hp: number | null; down: boolean; currency: number };
}

function buy(token: string, itemId: string, quantity = 1) {
  return buyRoute(
    authenticatedRequest("/npc/medea/buy", token, { itemId, quantity }),
  );
}

function eat(token: string, itemId: string) {
  return eatRoute(authenticatedRequest("/inventory/eat", token, { itemId }));
}

const candies = async (userId: string) =>
  (await getUnits(userId)).filter((u) => u.item_id === "star-candy").length;

beforeEach(async () => {
  setLocalEnv();
  await cleanupTestData();
});

afterAll(async () => {
  await cleanupTestData();
});

describe("buying from Medea", () => {
  it("sells Star Candy for 20 coins each", async () => {
    const p = await player({ currency: 70 });
    const res = await buy(p.accessToken, "star-candy", 3);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      spent: 60,
      newCurrency: 10,
    });
    expect(await candies(p.userId)).toBe(3);
  });

  it("refuses without the coins, taking nothing", async () => {
    const p = await player({ currency: 19 });
    const res = await buy(p.accessToken, "star-candy");
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("insufficient-funds");
    expect((await storedHp(p.userId)).currency).toBe(19);
    expect(await candies(p.userId)).toBe(0);
  });

  it("only sells her own stock", async () => {
    const p = await player({ currency: 1000 });
    const res = await buy(p.accessToken, "lute");
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("not-sold-here");
  });
});

describe("eating", () => {
  it("heals 100 and uses one up", async () => {
    const p = await player({ inventory_v2: { "star-candy": 2 } });
    await setHp(p.userId, 3);
    const res = await eat(p.accessToken, "star-candy");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, heal: 100 });
    expect(body.vitals.hp).toBeCloseTo(103, 0);
    expect((await storedHp(p.userId)).hp).toBeCloseTo(103, 0);
    expect(await candies(p.userId)).toBe(1);
  });

  it("never heals past max", async () => {
    const p = await player({ inventory_v2: { "star-candy": 1 } });
    await setHp(p.userId, 60);
    const res = await eat(p.accessToken, "star-candy");
    expect(res.status).toBe(200);
    expect((await storedHp(p.userId)).hp).toBe(MAX_HP);
  });

  it("refuses at full health, keeping the candy", async () => {
    const p = await player({ inventory_v2: { "star-candy": 1 } });
    const res = await eat(p.accessToken, "star-candy");
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("full");
    expect(await candies(p.userId)).toBe(1);
  });

  it("refuses while knocked out, keeping the candy", async () => {
    const p = await player({ inventory_v2: { "star-candy": 1 } });
    await setHp(p.userId, 0, true);
    const res = await eat(p.accessToken, "star-candy");
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("down");
    expect(await candies(p.userId)).toBe(1);
    expect((await storedHp(p.userId)).down).toBe(true);
  });

  it("refuses with none left", async () => {
    const p = await player();
    await setHp(p.userId, 10);
    const res = await eat(p.accessToken, "star-candy");
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("none-left");
    expect((await storedHp(p.userId)).hp).toBe(10);
  });

  it("refuses what isn't eaten", async () => {
    const p = await player({ inventory_v2: { cd: 1 } });
    await setHp(p.userId, 10);
    const res = await eat(p.accessToken, "cd");
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("not-consumable");
    expect((await getUnits(p.userId)).map((u) => u.item_id)).toEqual(["cd"]);
  });

  it("uses a copy up without healing when the Town server eats for a fight", async () => {
    const p = await player({ inventory_v2: { "star-candy": 1 } });
    await setHp(p.userId, 10);
    const { data } = await admin().rpc("eat_item", {
      p_user_id: p.userId,
      p_item_id: "star-candy",
      p_apply_hp: false,
    });
    expect(data).toMatchObject({ ok: true, heal: 100 });
    expect((await storedHp(p.userId)).hp).toBe(10);
    expect(await candies(p.userId)).toBe(0);
  });
});
