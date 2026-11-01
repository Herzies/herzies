/**
 * Integration tests for emotes against local Supabase.
 * Requires: `npx supabase start`, with migration 00132 applied.
 *
 * An emote is not an item: buying one appends its id to `herzies.emotes`,
 * once. Covered here: the listing, checkout (refusing one already owned),
 * fulfilment, `/api/inventory` carrying the list, and that a client can't
 * grant itself one. Stripe is faked; everything else is the real routes and
 * the real database.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { GET as inventoryRoute } from "@/app/api/inventory/route";
import { POST as checkout } from "@/app/api/store/checkout/route";
import { GET as listPremium } from "@/app/api/store/premium/route";
import {
  authenticatedRequest,
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
  getUserClient,
  setLocalEnv,
} from "./integration-helpers";

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

const waveProduct = (over: Record<string, unknown> = {}) => ({
  metadata: { emote_id: "wave" },
  default_price: {
    id: "price_wave",
    active: true,
    unit_amount: 2900,
    currency: "nok",
  },
  ...over,
});

beforeAll(() => {
  setLocalEnv();
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
});

beforeEach(() => {
  stripeProducts = [waveProduct()];
});

afterAll(async () => {
  await cleanupTestData();
}, 15000);

type Player = { userId: string; accessToken: string };

async function makePlayer(
  overrides: Record<string, unknown> = {},
): Promise<Player> {
  const user = await createTestUser();
  await createTestHerzie(user.userId, {
    inventory_v2: { cd: 1 },
    ...overrides,
  });
  return user;
}

const emotesOf = async (p: Player) => {
  const { data } = await getAdminClient()
    .from("herzies")
    .select("emotes")
    .eq("user_id", p.userId)
    .single();
  return data?.emotes as string[];
};

const buyWave = (p: Player) =>
  checkout(
    authenticatedRequest("/store/checkout", p.accessToken, {
      productId: "wave",
    }),
  );

/** Fulfils the player's latest order, as the Stripe webhook would. */
async function fulfilLatest(p: Player) {
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
}

describe("emotes", () => {
  it("lists Wave under its emote id, and ignores an unknown emote_id", async () => {
    stripeProducts = [
      waveProduct(),
      waveProduct({ metadata: { emote_id: "moonwalk" } }),
    ];
    const p = await makePlayer();
    const res = await listPremium(
      authenticatedRequest("/store/premium", p.accessToken, undefined, "GET"),
    );
    expect((await res.json()).items).toEqual([
      { itemId: "wave", priceId: "price_wave", amount: 2900, currency: "nok" },
    ]);
  });

  it("records an order granting the emote, and grants it once on fulfilment", async () => {
    const p = await makePlayer();
    expect((await buyWave(p)).status).toBe(200);
    const { data: orders } = await getAdminClient()
      .from("store_orders")
      .select(
        "grant_emote_id, grant_item_id, grant_bank_expansions, currency_amount",
      )
      .eq("user_id", p.userId);
    expect(orders).toEqual([
      {
        grant_emote_id: "wave",
        grant_item_id: null,
        grant_bank_expansions: null,
        currency_amount: 0,
      },
    ]);
    await fulfilLatest(p);
    expect(await emotesOf(p)).toEqual(["wave"]);

    // /api/inventory carries it.
    const inv = await inventoryRoute(
      authenticatedRequest("/inventory", p.accessToken, undefined, "GET"),
    );
    expect((await inv.json()).emotes).toEqual(["wave"]);
  });

  it("refuses to sell an emote already owned", async () => {
    const p = await makePlayer({ emotes: ["wave"] });
    expect((await buyWave(p)).status).toBe(409);
  });

  it("never grants it twice, even if two checkouts raced", async () => {
    const p = await makePlayer();
    await buyWave(p);
    await buyWave(p);
    const { data: orders } = await getAdminClient()
      .from("store_orders")
      .select("stripe_checkout_session_id")
      .eq("user_id", p.userId);
    for (const o of orders ?? []) {
      await getAdminClient().rpc("fulfill_store_order", {
        p_session_id: o.stripe_checkout_session_id,
        p_event_id: `evt_${Math.random().toString(36).slice(2)}`,
        p_to_ground: false,
      });
    }
    expect(await emotesOf(p)).toEqual(["wave"]);
  });

  it("can't be granted by the player themselves", async () => {
    const p = await makePlayer();
    await getUserClient(p.accessToken)
      .from("herzies")
      .update({ emotes: ["wave"] })
      .eq("user_id", p.userId);
    expect(await emotesOf(p)).toEqual([]);
  });
});
