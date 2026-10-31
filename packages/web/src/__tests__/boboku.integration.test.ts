/**
 * Integration tests for Boboku (00112): the always-on instrument seller. No
 * event behind him; anyone can buy any instrument for coins.
 *
 * Requires: `npx supabase start`
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as buyRoute } from "@/app/api/npc/boboku/buy/route";
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

async function player(currency: number) {
  const user = await createTestUser();
  await createTestHerzie(user.userId, { inventory_v2: {}, currency });
  return user;
}

function buy(token: string, itemId: string, quantity = 1) {
  return buyRoute(
    authenticatedRequest("/npc/boboku/buy", token, { itemId, quantity }),
  );
}

async function currencyOf(userId: string) {
  const { data } = await admin()
    .from("herzies")
    .select("currency")
    .eq("user_id", userId)
    .single();
  return data!.currency as number;
}

beforeEach(async () => {
  setLocalEnv();
  await cleanupTestData();
});

afterAll(async () => {
  await cleanupTestData();
});

describe("buying from Boboku", () => {
  it("sells an instrument for 100 coins, class or not", async () => {
    const p = await player(250);
    const res = await buy(p.accessToken, "lute");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      spent: 100,
      newCurrency: 150,
    });
    expect(await currencyOf(p.userId)).toBe(150);
    expect((await getUnits(p.userId)).map((u) => u.item_id)).toEqual(["lute"]);
  });

  it("refuses without the coins, taking nothing", async () => {
    const p = await player(99);
    const res = await buy(p.accessToken, "compact-discs");
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("insufficient-funds");
    expect(await currencyOf(p.userId)).toBe(99);
    expect(await getUnits(p.userId)).toEqual([]);
  });

  it("sells his spare cap, which a herzie can wear", async () => {
    const p = await player(500);
    const res = await buy(p.accessToken, "sixpence");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ spent: 300, newCurrency: 200 });
    expect((await getUnits(p.userId)).map((u) => u.item_id)).toEqual([
      "sixpence",
    ]);
    const { data: row } = await admin()
      .from("items")
      .select("equipable, equip_slot")
      .eq("id", "sixpence")
      .single();
    expect(row).toEqual({ equipable: true, equip_slot: "head" });
  });

  it("only sells what's on his list", async () => {
    const p = await player(1000);
    const res = await buy(p.accessToken, "cd");
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("not-sold-here");
    expect(await currencyOf(p.userId)).toBe(1000);
  });
});
