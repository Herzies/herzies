/**
 * Integration tests for the full trade flow against local Supabase.
 * Requires: `npx supabase start`
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as acceptTrade } from "@/app/api/trade/accept/route";
import { POST as cancelTrade } from "@/app/api/trade/cancel/route";
// Import the actual route handlers
import { POST as createTrade } from "@/app/api/trade/create/route";
import { POST as joinTrade } from "@/app/api/trade/join/route";
import { POST as lockTrade } from "@/app/api/trade/lock/route";
import { POST as offerTrade } from "@/app/api/trade/offer/route";
import { GET as tradeStatus } from "@/app/api/trade/status/route";
import {
  authenticatedRequest,
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  setLocalEnv,
} from "./integration-helpers";

let userA: { userId: string; accessToken: string };
let userB: { userId: string; accessToken: string };
let herzieA: Record<string, unknown>;
let herzieB: Record<string, unknown>;

beforeAll(async () => {
  setLocalEnv();
  userA = await createTestUser();
  userB = await createTestUser();
  herzieA = await createTestHerzie(userA.userId, {
    inventory_v2: { cd: 10, "first-edition": 1 },
    currency: 200,
  });
  herzieB = await createTestHerzie(userB.userId, {
    inventory_v2: { cd: 5 },
    currency: 50,
  });

  // Make them friends (required for trading)
  const { getAdminClient } = await import("./integration-helpers");
  const admin = getAdminClient();
  await admin
    .from("herzies")
    .update({
      friend_codes: [herzieB.friend_code],
    })
    .eq("user_id", userA.userId);
  await admin
    .from("herzies")
    .update({
      friend_codes: [herzieA.friend_code],
    })
    .eq("user_id", userB.userId);
}, 15000);

afterAll(async () => {
  await cleanupTestData();
}, 10000);

describe("Trade flow integration", () => {
  let tradeId: string;

  it("creates a trade", async () => {
    const res = await createTrade(
      authenticatedRequest("/trade/create", userA.accessToken, {
        targetFriendCode: herzieB.friend_code,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tradeId).toBeDefined();
    tradeId = body.tradeId;
  });

  it("prevents duplicate active trade", async () => {
    const res = await createTrade(
      authenticatedRequest("/trade/create", userA.accessToken, {
        targetFriendCode: herzieB.friend_code,
      }),
    );
    expect(res.status).toBe(409);
  });

  it("target joins the trade", async () => {
    const res = await joinTrade(
      authenticatedRequest("/trade/join", userB.accessToken, { tradeId }),
    );
    expect(res.status).toBe(200);
  });

  it("initiator submits an offer", async () => {
    const res = await offerTrade(
      authenticatedRequest("/trade/offer", userA.accessToken, {
        tradeId,
        offer: { items: { cd: 3 }, currency: 50 },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects offer exceeding inventory", async () => {
    const res = await offerTrade(
      authenticatedRequest("/trade/offer", userA.accessToken, {
        tradeId,
        offer: { items: { cd: 999 }, currency: 0 },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("target submits an offer", async () => {
    const res = await offerTrade(
      authenticatedRequest("/trade/offer", userB.accessToken, {
        tradeId,
        offer: { items: { cd: 2 }, currency: 10 },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("both sides lock", async () => {
    const resA = await lockTrade(
      authenticatedRequest("/trade/lock", userA.accessToken, { tradeId }),
    );
    expect(resA.status).toBe(200);

    const resB = await lockTrade(
      authenticatedRequest("/trade/lock", userB.accessToken, { tradeId }),
    );
    expect(resB.status).toBe(200);
  });

  it("both sides accept and trade executes", async () => {
    const resA = await acceptTrade(
      authenticatedRequest("/trade/accept", userA.accessToken, { tradeId }),
    );
    expect(resA.status).toBe(200);
    const bodyA = await resA.json();
    expect(bodyA.completed).toBe(false); // waiting for B

    const resB = await acceptTrade(
      authenticatedRequest("/trade/accept", userB.accessToken, { tradeId }),
    );
    expect(resB.status).toBe(200);
    const bodyB = await resB.json();
    expect(bodyB.completed).toBe(true);
  });

  it("inventories and currency updated correctly after trade", async () => {
    const { getAdminClient } = await import("./integration-helpers");
    const admin = getAdminClient();

    const { data: a } = await admin
      .from("herzies")
      .select("inventory_v2, currency")
      .eq("user_id", userA.userId)
      .single();

    const { data: b } = await admin
      .from("herzies")
      .select("inventory_v2, currency")
      .eq("user_id", userB.userId)
      .single();

    // A started with: cd:10, first-edition:1, currency:200
    // A offered: cd:3, currency:50
    // A received: cd:2, currency:10
    // A should have: cd:9, first-edition:1, currency:160
    expect(a!.inventory_v2).toEqual({ cd: 9, "first-edition": 1 });
    expect(a!.currency).toBe(160);

    // B started with: cd:5, currency:50
    // B offered: cd:2, currency:10
    // B received: cd:3, currency:50
    // B should have: cd:6, currency:90
    expect(b!.inventory_v2).toEqual({ cd: 6 });
    expect(b!.currency).toBe(90);
  });
});

describe("Trade cancellation", () => {
  it("can cancel a pending trade", async () => {
    // Create a fresh trade
    const res = await createTrade(
      authenticatedRequest("/trade/create", userA.accessToken, {
        targetFriendCode: herzieB.friend_code,
      }),
    );
    const { tradeId } = await res.json();

    const cancelRes = await cancelTrade(
      authenticatedRequest("/trade/cancel", userA.accessToken, { tradeId }),
    );
    expect(cancelRes.status).toBe(200);
  });
});
