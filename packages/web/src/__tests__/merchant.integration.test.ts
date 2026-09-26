/**
 * Integration tests for Good ol' George (00081): buying from a live merchant
 * event, its per-player and total limits, and what the events feed shows.
 *
 * Requires: `npx supabase start`
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as activeEvents } from "@/app/api/events/active/route";
import { POST as buyRoute } from "@/app/api/events/merchant/buy/route";
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
const HOUR = 3_600_000;

type Stock = {
  itemId: string;
  price: number;
  perPlayerLimit?: number;
  totalStock?: number;
};

async function george(
  stock: Stock[],
  window = { from: -HOUR, to: HOUR },
): Promise<string> {
  const { data, error } = await admin()
    .from("events")
    .insert({
      type: "merchant",
      title: "Good ol' George",
      active: true,
      starts_at: new Date(Date.now() + window.from).toISOString(),
      ends_at: new Date(Date.now() + window.to).toISOString(),
      config: { stock },
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message);
  return data.id as string;
}

async function player(currency = 1000) {
  const user = await createTestUser();
  await createTestHerzie(user.userId, { inventory_v2: {}, currency });
  return user;
}

function buy(token: string, eventId: string, itemId: string, quantity = 1) {
  return buyRoute(
    authenticatedRequest("/events/merchant/buy", token, {
      eventId,
      itemId,
      quantity,
    }),
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

describe("buying from George", () => {
  it("charges his price and hands over the copies", async () => {
    const eventId = await george([{ itemId: "cd", price: 40 }]);
    const p = await player(100);

    const res = await buy(p.accessToken, eventId, "cd", 2);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, spent: 80, newCurrency: 20 });

    expect(await currencyOf(p.userId)).toBe(20);
    expect((await getUnits(p.userId)).map((u) => u.item_id)).toEqual([
      "cd",
      "cd",
    ]);
  });

  it("enforces the per-player cap", async () => {
    const eventId = await george([
      { itemId: "cd", price: 1, perPlayerLimit: 2 },
    ]);
    const p = await player();
    expect((await buy(p.accessToken, eventId, "cd", 2)).status).toBe(200);
    const res = await buy(p.accessToken, eventId, "cd", 1);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("limit-reached");

    // Someone else's cap is their own.
    const q = await player();
    expect((await buy(q.accessToken, eventId, "cd", 2)).status).toBe(200);
  });

  it("sells the last unit exactly once under a race", async () => {
    const eventId = await george([{ itemId: "cd", price: 1, totalStock: 1 }]);
    const [a, b] = await Promise.all([player(), player()]);

    const results = await Promise.all([
      buy(a.accessToken, eventId, "cd"),
      buy(b.accessToken, eventId, "cd"),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);

    const units = [
      ...(await getUnits(a.userId)),
      ...(await getUnits(b.userId)),
    ];
    expect(units).toHaveLength(1);
  });

  it("refuses items he doesn't stock", async () => {
    const eventId = await george([{ itemId: "cd", price: 1 }]);
    const p = await player();
    const res = await buy(p.accessToken, eventId, "headphones");
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("not-sold-here");
  });

  it("refuses once he has left", async () => {
    const eventId = await george([{ itemId: "cd", price: 1 }], {
      from: -2 * HOUR,
      to: -HOUR,
    });
    const p = await player();
    const res = await buy(p.accessToken, eventId, "cd");
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("not-live");
  });

  it("refuses without enough currency, charging nothing", async () => {
    const eventId = await george([{ itemId: "cd", price: 500 }]);
    const p = await player(100);
    const res = await buy(p.accessToken, eventId, "cd");
    expect(res.status).toBe(400);
    expect(await currencyOf(p.userId)).toBe(100);
    expect(await getUnits(p.userId)).toHaveLength(0);
  });
});

describe("the events feed", () => {
  it("shows remaining stock and what the caller bought", async () => {
    const eventId = await george([
      { itemId: "cd", price: 5, perPlayerLimit: 3, totalStock: 10 },
    ]);
    const p = await player();
    await buy(p.accessToken, eventId, "cd", 2);

    const res = await activeEvents(
      authenticatedRequest("/events/active", p.accessToken, undefined, "GET"),
    );
    const { events } = await res.json();
    expect(events[0].config.stock).toEqual([
      {
        itemId: "cd",
        price: 5,
        perPlayerLimit: 3,
        totalStock: 10,
        remaining: 8,
        yourBought: 2,
      },
    ]);
  });
});
