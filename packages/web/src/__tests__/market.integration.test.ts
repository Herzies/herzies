/**
 * Integration tests for the market board (00126): list a copy at a fixed
 * price, someone buys it while you're away, and you collect the coins (less
 * the market's cut) or the unsold copy from the board later.
 *
 * Requires: `npx supabase start`
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as browseRoute } from "@/app/api/market/browse/route";
import { POST as buyRoute } from "@/app/api/market/buy/route";
import { POST as cancelRoute } from "@/app/api/market/cancel/route";
import { POST as collectRoute } from "@/app/api/market/collect/route";
import { POST as listRoute } from "@/app/api/market/list/route";
import { GET as mineRoute } from "@/app/api/market/mine/route";
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

async function player(
  inventory: Record<string, number> = {},
  currency = 0,
  extra: Record<string, unknown> = {},
) {
  const user = await createTestUser();
  await createTestHerzie(user.userId, {
    inventory_v2: inventory,
    currency,
    ...extra,
  });
  return user;
}

function list(token: string, unitId: string, price: number) {
  return listRoute(
    authenticatedRequest("/market/list", token, { unitId, price }),
  );
}

function buy(token: string, listingId: string) {
  return buyRoute(authenticatedRequest("/market/buy", token, { listingId }));
}

function cancel(token: string, listingId: string) {
  return cancelRoute(
    authenticatedRequest("/market/cancel", token, { listingId }),
  );
}

function collect(token: string) {
  return collectRoute(authenticatedRequest("/market/collect", token, {}));
}

function mine(token: string) {
  return mineRoute(
    authenticatedRequest("/market/mine", token, undefined, "GET"),
  );
}

function browse(token: string, query = "") {
  return browseRoute(
    authenticatedRequest(`/market/browse${query}`, token, undefined, "GET"),
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

/** List the player's first copy of `itemId` and return the listing's id. */
async function listFirst(
  user: { userId: string; accessToken: string },
  itemId: string,
  price: number,
) {
  const unit = (await getUnits(user.userId)).find((u) => u.item_id === itemId);
  const res = await list(user.accessToken, unit!.id, price);
  expect(res.status).toBe(200);
  return (await res.json()).listing.id as string;
}

beforeEach(async () => {
  setLocalEnv();
  await cleanupTestData();
});

afterAll(async () => {
  await cleanupTestData();
});

describe("listing", () => {
  it("takes the copy out of the seller's bank and puts it on the board", async () => {
    const seller = await player({ boombox: 1 });
    const buyer = await player({}, 0);
    const [unit] = await getUnits(seller.userId);

    const res = await list(seller.accessToken, unit.id, 400);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.listing).toMatchObject({
      itemId: "boombox",
      price: 400,
      fee: 20,
      status: "active",
    });
    expect(body.inventory).toEqual({});
    expect(await getUnits(seller.userId)).toEqual([]);

    const board = await (await browse(buyer.accessToken)).json();
    expect(board.listings.map((l: { id: string }) => l.id)).toEqual([
      body.listing.id,
    ]);
  });

  it("keeps the copy's upgrade level", async () => {
    const seller = await player({ boombox: 1 }, 0, {
      item_upgrades: { boombox: 2 },
    });
    const buyer = await player({}, 1000);
    const listingId = await listFirst(seller, "boombox", 400);

    expect((await buy(buyer.accessToken, listingId)).status).toBe(200);
    expect(await getUnits(buyer.userId)).toMatchObject([
      { item_id: "boombox", upgrade_level: 2 },
    ]);
  });

  it("refuses a copy that's being worn", async () => {
    const seller = await player({ boombox: 1 }, 0, {
      equipped: { ground_left: "boombox" },
    });
    const [unit] = await getUnits(seller.userId);
    const res = await list(seller.accessToken, unit.id, 400);
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("equipped");
    expect(await getUnits(seller.userId)).toHaveLength(1);
  });

  it("refuses class gear, which is bound to its herzie", async () => {
    const seller = await player({ lute: 1 });
    const [unit] = await getUnits(seller.userId);
    const res = await list(seller.accessToken, unit.id, 400);
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("bound");
  });

  it("refuses a price at or below what the game pays", async () => {
    const seller = await player({ boombox: 1 });
    const [unit] = await getUnits(seller.userId);
    const res = await list(seller.accessToken, unit.id, 250);
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("price-too-low");
    expect(await getUnits(seller.userId)).toHaveLength(1);
  });

  it("refuses someone else's copy", async () => {
    const owner = await player({ boombox: 1 });
    const thief = await player();
    const [unit] = await getUnits(owner.userId);
    const res = await list(thief.accessToken, unit.id, 400);
    expect(res.status).toBe(404);
    expect((await res.json()).reason).toBe("not-owned");
  });

  it("allows six listings at once, no more", async () => {
    const seller = await player({ cd: 7 });
    const units = await getUnits(seller.userId);
    for (const u of units.slice(0, 6)) {
      expect((await list(seller.accessToken, u.id, 50)).status).toBe(200);
    }
    const res = await list(seller.accessToken, units[6].id, 50);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("too-many-listings");
  });
});

describe("buying", () => {
  it("hands over the copy and holds the coins at the board", async () => {
    const seller = await player({ boombox: 1 }, 10);
    const buyer = await player({}, 1000);
    const listingId = await listFirst(seller, "boombox", 400);

    const res = await buy(buyer.accessToken, listingId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, newCurrency: 600 });
    expect((await getUnits(buyer.userId)).map((u) => u.item_id)).toEqual([
      "boombox",
    ]);
    // The seller isn't paid until they collect.
    expect(await currencyOf(seller.userId)).toBe(10);

    const board = await (await browse(buyer.accessToken)).json();
    expect(board.listings).toEqual([]);
  });

  it("refuses without the coins, taking nothing", async () => {
    const seller = await player({ boombox: 1 });
    const buyer = await player({}, 399);
    const listingId = await listFirst(seller, "boombox", 400);

    const res = await buy(buyer.accessToken, listingId);
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("insufficient-funds");
    expect(await currencyOf(buyer.userId)).toBe(399);
    expect(await getUnits(buyer.userId)).toEqual([]);
  });

  it("won't sell you your own listing", async () => {
    const seller = await player({ boombox: 1 }, 1000);
    const listingId = await listFirst(seller, "boombox", 400);
    const res = await buy(seller.accessToken, listingId);
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("own-listing");
  });

  it("won't sell an expired listing", async () => {
    const seller = await player({ boombox: 1 });
    const buyer = await player({}, 1000);
    const listingId = await listFirst(seller, "boombox", 400);
    await admin()
      .from("market_listings")
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq("id", listingId);

    const res = await buy(buyer.accessToken, listingId);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("gone");
    expect(await currencyOf(buyer.userId)).toBe(1000);

    const board = await (await browse(buyer.accessToken)).json();
    expect(board.listings).toEqual([]);
  });

  it("sells to only one of two buyers racing for it", async () => {
    const seller = await player({ boombox: 1 });
    const a = await player({}, 1000);
    const b = await player({}, 1000);
    const listingId = await listFirst(seller, "boombox", 400);

    const statuses = (
      await Promise.all([
        buy(a.accessToken, listingId),
        buy(b.accessToken, listingId),
      ])
    ).map((r) => r.status);
    expect(statuses.sort()).toEqual([200, 409]);

    const total = (await currencyOf(a.userId)) + (await currencyOf(b.userId));
    expect(total).toBe(1600);
    const copies =
      (await getUnits(a.userId)).length + (await getUnits(b.userId)).length;
    expect(copies).toBe(1);
  });
});

describe("collecting", () => {
  it("pays the seller the price less the market's cut, once", async () => {
    const seller = await player({ boombox: 1 }, 10);
    const buyer = await player({}, 1000);
    const listingId = await listFirst(seller, "boombox", 400);
    await buy(buyer.accessToken, listingId);

    const stall = await (await mine(seller.accessToken)).json();
    expect(stall).toMatchObject({ coinsWaiting: 380, itemsWaiting: 0 });

    const res = await collect(seller.accessToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      coins: 380,
      items: 0,
      newCurrency: 390,
    });
    expect(await currencyOf(seller.userId)).toBe(390);

    const again = await (await collect(seller.accessToken)).json();
    expect(again).toMatchObject({ coins: 0, items: 0 });
    expect(await currencyOf(seller.userId)).toBe(390);
  });

  it("gives back a cancelled listing's copy", async () => {
    const seller = await player({ boombox: 1 });
    const listingId = await listFirst(seller, "boombox", 400);

    expect((await cancel(seller.accessToken, listingId)).status).toBe(200);
    const stall = await (await mine(seller.accessToken)).json();
    expect(stall).toMatchObject({ active: [], itemsWaiting: 1 });

    await collect(seller.accessToken);
    expect((await getUnits(seller.userId)).map((u) => u.item_id)).toEqual([
      "boombox",
    ]);
  });

  it("gives back an expired listing's copy", async () => {
    const seller = await player({ boombox: 1 });
    const listingId = await listFirst(seller, "boombox", 400);
    await admin()
      .from("market_listings")
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq("id", listingId);

    const stall = await (await mine(seller.accessToken)).json();
    expect(stall).toMatchObject({ active: [], itemsWaiting: 1 });

    const res = await (await collect(seller.accessToken)).json();
    expect(res).toMatchObject({ coins: 0, items: 1 });
    expect((await getUnits(seller.userId)).map((u) => u.item_id)).toEqual([
      "boombox",
    ]);
  });

  it("can't cancel a listing that already sold", async () => {
    const seller = await player({ boombox: 1 });
    const buyer = await player({}, 1000);
    const listingId = await listFirst(seller, "boombox", 400);
    await buy(buyer.accessToken, listingId);

    const res = await cancel(seller.accessToken, listingId);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("gone");
  });
});
