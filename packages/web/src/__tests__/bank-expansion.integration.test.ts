/**
 * Integration tests for Inventory Expansions against local Supabase.
 * Requires: `npx supabase start`, with migration 00080 applied.
 *
 * An expansion is not an item: buying one raises `herzies.bank_expansions`, and
 * every "is there room" check in the stack reads capacity from it. What is
 * covered here is the money path (checkout -> order -> fulfilment) and that the
 * server-side capacity checks honour the result. Stripe is faked; everything
 * else is the real routes and the real database.
 */
import { BANK_EXPANSION_SLOTS, BANK_SLOT_COUNT } from "@herzies/shared";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { POST as buy } from "@/app/api/inventory/buy/route";
import { POST as checkout } from "@/app/api/store/checkout/route";
import { GET as listPremium } from "@/app/api/store/premium/route";
import { POST as syncRoute } from "@/app/api/sync/route";
import {
  authenticatedRequest,
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
  getAnonClient,
  setLocalEnv,
} from "./integration-helpers";

/** What the fake Stripe is currently selling. Reset per test. */
let stripeProducts: unknown[] = [];

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    products: { list: async () => ({ data: stripeProducts }) },
    checkout: {
      sessions: {
        create: async () => ({
          id: `cs_test_${Math.random().toString(36).slice(2)}`,
          url: "https://checkout.stripe.com/pay/fake",
        }),
      },
    },
  }),
}));

const expansionProduct = (over: Record<string, unknown> = {}) => ({
  metadata: { perk_id: "bank-expansion" },
  default_price: {
    id: "price_expansion",
    active: true,
    unit_amount: 9900,
    currency: "nok",
  },
  ...over,
});

beforeAll(() => {
  setLocalEnv();
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
});

beforeEach(() => {
  stripeProducts = [expansionProduct()];
});

afterAll(async () => {
  await cleanupTestData();
}, 15000);

type Player = { userId: string; accessToken: string };

async function makePlayer(
  inventory: Record<string, number> = { cd: 1 },
  herzieOverrides: Record<string, unknown> = {},
): Promise<Player> {
  const user = await createTestUser();
  await createTestHerzie(user.userId, {
    inventory_v2: inventory,
    currency: 7000,
    ...herzieOverrides,
  });
  return user;
}

const bankExpansionsOf = async (p: Player) => {
  const { data } = await getAdminClient()
    .from("herzies")
    .select("bank_expansions")
    .eq("user_id", p.userId)
    .single();
  return data?.bank_expansions as number;
};

const post = (
  handler: (r: Request) => Promise<Response>,
  path: string,
  p: Player,
  body: unknown,
) => handler(authenticatedRequest(path, p.accessToken, body));

/** A bank with every one of its starting slots taken. */
const FULL = { headphones: BANK_SLOT_COUNT };

/** Runs a checkout and then fulfils its order, as the Stripe webhook would. */
async function buyExpansion(p: Player) {
  const res = await post(checkout, "/store/checkout", p, {
    productId: "bank-expansion",
  });
  if (res.status !== 200) return { res, fulfilled: false };
  const { data: order } = await getAdminClient()
    .from("store_orders")
    .select("stripe_checkout_session_id")
    .eq("user_id", p.userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  const { error } = await getAdminClient().rpc("fulfill_store_order", {
    p_session_id: order?.stripe_checkout_session_id,
    p_event_id: `evt_${Math.random().toString(36).slice(2)}`,
    p_to_ground: false,
  });
  expect(error).toBeNull();
  return { res, fulfilled: true, sessionId: order?.stripe_checkout_session_id };
}

describe("the premium listing", () => {
  it("lists the expansion under its own id, priced by Stripe", async () => {
    const p = await makePlayer();
    const res = await listPremium(
      authenticatedRequest("/store/premium", p.accessToken, undefined, "GET"),
    );
    const { items } = await res.json();
    expect(items).toEqual([
      {
        itemId: "bank-expansion",
        priceId: "price_expansion",
        amount: 9900,
        currency: "nok",
      },
    ]);
  });

  it("ignores a product whose perk_id is a typo, rather than selling it", async () => {
    stripeProducts = [
      expansionProduct({ metadata: { perk_id: "bank-expanshun" } }),
    ];
    const p = await makePlayer();
    const res = await listPremium(
      authenticatedRequest("/store/premium", p.accessToken, undefined, "GET"),
    );
    expect((await res.json()).items).toEqual([]);
  });
});

describe("checkout", () => {
  it("does not refuse on a full bank: nothing is placed in it", async () => {
    const p = await makePlayer(FULL);
    const res = await post(checkout, "/store/checkout", p, {
      productId: "bank-expansion",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).url).toContain("checkout.stripe.com");
  });

  it("records an order that grants an expansion and no item or coins", async () => {
    const p = await makePlayer();
    await post(checkout, "/store/checkout", p, { productId: "bank-expansion" });
    const { data: orders } = await getAdminClient()
      .from("store_orders")
      .select("grant_bank_expansions, grant_item_id, currency_amount, status")
      .eq("user_id", p.userId);
    expect(orders).toEqual([
      {
        grant_bank_expansions: 1,
        grant_item_id: null,
        currency_amount: 0,
        status: "pending",
      },
    ]);
  });

  it("refuses once the player is at the cap, before any order exists", async () => {
    const { MAX_BANK_EXPANSIONS } = await import("@herzies/shared");
    const p = await makePlayer(
      { cd: 1 },
      { bank_expansions: MAX_BANK_EXPANSIONS },
    );
    const res = await post(checkout, "/store/checkout", p, {
      productId: "bank-expansion",
    });
    expect(res.status).toBe(409);
    const { data: orders } = await getAdminClient()
      .from("store_orders")
      .select("id")
      .eq("user_id", p.userId);
    expect(orders).toEqual([]);
  });

  it("404s an expansion Stripe is not selling", async () => {
    stripeProducts = [];
    const p = await makePlayer();
    const res = await post(checkout, "/store/checkout", p, {
      productId: "bank-expansion",
    });
    expect(res.status).toBe(404);
  });
});

describe("fulfilment", () => {
  it("adds exactly one expansion", async () => {
    const p = await makePlayer();
    expect(await bankExpansionsOf(p)).toBe(0);
    await buyExpansion(p);
    expect(await bankExpansionsOf(p)).toBe(1);
  });

  it("is idempotent: a Stripe retry does not pay out twice", async () => {
    const p = await makePlayer();
    const { sessionId } = await buyExpansion(p);
    const retry = await getAdminClient().rpc("fulfill_store_order", {
      p_session_id: sessionId,
      p_event_id: "evt_retry",
      p_to_ground: false,
    });
    expect(retry.data).toBe(true);
    expect(await bankExpansionsOf(p)).toBe(1);
  });

  it("stacks across purchases", async () => {
    const p = await makePlayer();
    await buyExpansion(p);
    await buyExpansion(p);
    expect(await bankExpansionsOf(p)).toBe(2);
  });

  it("still credits a coin order as coins, untouched by the new branch", async () => {
    const p = await makePlayer();
    const admin = getAdminClient();
    await admin.from("store_orders").insert({
      user_id: p.userId,
      product_id: "coins-x",
      stripe_checkout_session_id: `cs_coins_${p.userId}`,
      currency_amount: 500,
    });
    await admin.rpc("fulfill_store_order", {
      p_session_id: `cs_coins_${p.userId}`,
      p_event_id: `evt_coins_${p.userId}`,
      p_to_ground: false,
    });
    const { data } = await admin
      .from("herzies")
      .select("currency, bank_expansions")
      .eq("user_id", p.userId)
      .single();
    expect(data).toEqual({ currency: 7500, bank_expansions: 0 });
  });

  it("refuses an order that grants both an item and an expansion", async () => {
    const p = await makePlayer();
    const { error } = await getAdminClient()
      .from("store_orders")
      .insert({
        user_id: p.userId,
        product_id: "x",
        stripe_checkout_session_id: `cs_both_${p.userId}`,
        currency_amount: 0,
        grant_item_id: "cd",
        grant_bank_expansions: 1,
      });
    expect(error).not.toBeNull();
  });
});

describe("the column is not writable by the player", () => {
  // The herzies UPDATE policy limits rows, not columns, so without the guard
  // trigger any signed-in player could PATCH themselves free capacity.
  it("rejects a client write of bank_expansions", async () => {
    const p = await makePlayer();
    const client = getAnonClient();
    await client.auth.setSession({
      access_token: p.accessToken,
      refresh_token: "unused",
    });
    const { error } = await client
      .from("herzies")
      .update({ bank_expansions: 50 })
      .eq("user_id", p.userId);
    expect(error?.message).toMatch(/bank_expansions/);
    expect(await bankExpansionsOf(p)).toBe(0);
  });

  it("rejects a client inserting a herzie that starts with expansions", async () => {
    const user = await createTestUser();
    const client = getAnonClient();
    await client.auth.setSession({
      access_token: user.accessToken,
      refresh_token: "unused",
    });
    const { error } = await client.from("herzies").insert({
      user_id: user.userId,
      name: `Cheat-${Date.now()}`,
      friend_code: "HERZ-CHEAT1",
      appearance: {},
      bank_expansions: 9,
    });
    expect(error?.message).toMatch(/bank_expansions/);
  });
});

describe("capacity is honoured server-side", () => {
  it("refuses a coin purchase on a full bank, then allows it once expanded", async () => {
    const p = await makePlayer(FULL);
    const attempt = () =>
      post(buy, "/inventory/buy", p, { itemId: "prism", quantity: 1 });

    expect((await attempt()).status).toBe(409);
    await buyExpansion(p);
    expect((await attempt()).status).toBe(200);
  });

  it("allows exactly BANK_EXPANSION_SLOTS more items, then refuses again", async () => {
    const p = await makePlayer(FULL, { currency: 100000 });
    await buyExpansion(p);
    const res = await post(buy, "/inventory/buy", p, {
      itemId: "prism",
      quantity: BANK_EXPANSION_SLOTS,
    });
    expect(res.status).toBe(200);
    const over = await post(buy, "/inventory/buy", p, {
      itemId: "prism",
      quantity: 1,
    });
    expect(over.status).toBe(409);
  });

  it("reports the count on every sync, so the client can size its grid", async () => {
    const p = await makePlayer();
    await buyExpansion(p);
    await buyExpansion(p);
    const res = await post(syncRoute, "/sync", p, {
      nowPlaying: null,
      minutesListened: 0,
      genres: [],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).bankExpansions).toBe(2);
  });
});
