import {
  BANK_EXPANSION,
  bankCapacity,
  getItem,
  hasRoomFor,
  MAX_BANK_EXPANSIONS,
  normalizeEquipped,
} from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { checkoutSchema, isParseError, parseBody } from "@/lib/schemas";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase-admin";

/** What a premium purchase grants: a catalog item, or one Inventory Expansion
 * (which is not an item — see BANK_EXPANSION). */
type PremiumKind = "item" | "bank-expansion";

/**
 * Resolves a premium good for sale, by the same rule the /store/premium
 * listing uses: an active Stripe product whose `metadata.item_id` names a
 * real catalog item, or whose `metadata.perk_id` is the Inventory Expansion.
 * Returns the price to charge and what to grant.
 *
 * The good and the price are both read from Stripe here rather than taken
 * from the request. The client only ever names *which* good it wants — it can
 * neither choose the price nor smuggle in something that isn't for sale.
 */
async function findPremiumItem(
  id: string,
): Promise<{ priceId: string; kind: PremiumKind } | null> {
  const kind: PremiumKind | null = getItem(id)
    ? "item"
    : id === BANK_EXPANSION.id
      ? "bank-expansion"
      : null;
  if (!kind) return null;

  const stripe = getStripe();
  const products = await stripe.products.list({
    active: true,
    expand: ["data.default_price"],
    limit: 100,
  });

  for (const product of products.data) {
    const listedAs =
      kind === "item" ? product.metadata?.item_id : product.metadata?.perk_id;
    if (listedAs !== id) continue;
    const price = product.default_price;
    if (!price || typeof price === "string") continue;
    if (!price.active || price.unit_amount == null) continue;
    return { priceId: price.id, kind };
  }
  return null;
}

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, checkoutSchema);
  if (isParseError(body)) return body;

  const { productId } = body;

  const admin = createAdminClient();

  const { data: product } = await admin
    .from("store_products")
    .select("id, stripe_price_id, currency_amount, active")
    .eq("id", productId)
    .single();

  // `productId` is either an active coin pack or, failing that, a catalog item
  // id sold for money. Coin packs are checked first so a future item id that
  // collides with a pack id can't shadow it.
  let premium: { priceId: string; kind: PremiumKind } | null = null;
  if (!product?.active) {
    if (!process.env.STRIPE_SECRET_KEY) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    premium = await findPremiumItem(productId);
    if (!premium) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    const { data: herzie } = await admin
      .from("herzies")
      .select("inventory_v2, equipped, bank_expansions")
      .eq("user_id", auth.userId)
      .single();

    if (premium.kind === "bank-expansion") {
      // Nothing is placed in the bank, so a full bank is no reason to refuse —
      // it is exactly when someone wants this. The only limit is the cap, and
      // it is checked here, before money is taken, never at fulfilment (where
      // refusing would destroy a paid purchase). Two checkouts opened at once
      // can therefore overshoot it by one, which is harmless.
      if ((herzie?.bank_expansions ?? 0) >= MAX_BANK_EXPANSIONS) {
        return NextResponse.json(
          { error: "You already have the maximum inventory size" },
          { status: 409 },
        );
      }
    } else {
      // Refuse before taking money if there is nowhere to put the item. The
      // bank is a fixed number of slots (bankCapacity) and an over-capacity
      // item simply does not render, so without this a player could pay for
      // something they cannot see. The webhook re-checks at grant time, since
      // the bank can fill while Stripe Checkout is open; there it diverts to
      // the ground rather than refusing, because by then the money is taken.
      const room = hasRoomFor(
        (herzie?.inventory_v2 ?? {}) as Record<string, number>,
        normalizeEquipped(herzie?.equipped),
        productId,
        bankCapacity(herzie?.bank_expansions),
      );
      if (!room) {
        return NextResponse.json(
          { error: "Your bank is full — sell something first" },
          { status: 409 },
        );
      }
    }
  }

  // Test-mode bypass: lets the purchase funnel (order row -> fulfillment RPC
  // -> currency credit -> app refresh) be exercised end-to-end before Stripe
  // is configured, without a browser/payment step. Gated on NODE_ENV so a
  // misconfigured production deploy (missing key) fails loudly instead of
  // silently granting free currency.
  if (!process.env.STRIPE_SECRET_KEY) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json(
        { error: "Store is not configured" },
        { status: 500 },
      );
    }

    const sessionId = `test_${crypto.randomUUID()}`;

    const { error: insertError } = await admin.from("store_orders").insert({
      user_id: auth.userId,
      product_id: productId,
      stripe_checkout_session_id: sessionId,
      // currency_amount is NOT NULL; an item or expansion credits no coins.
      currency_amount: premium ? 0 : (product?.currency_amount ?? 0),
      grant_item_id: premium?.kind === "item" ? productId : null,
      grant_bank_expansions: premium?.kind === "bank-expansion" ? 1 : null,
    });

    if (insertError) {
      return NextResponse.json(
        { error: "Failed to record order" },
        { status: 500 },
      );
    }

    // Fulfill immediately through the same RPC the real webhook calls, so
    // this test path proves the actual crediting logic, not a stand-in.
    const { error: fulfillError } = await admin.rpc("fulfill_store_order", {
      p_session_id: sessionId,
      p_event_id: `test_${sessionId}`,
    });

    if (fulfillError) {
      return NextResponse.json(
        { error: "Failed to fulfill order" },
        { status: 500 },
      );
    }

    return NextResponse.json({ testMode: true });
  }

  const webUrl = new URL(request.url).origin;

  // One of the two resolved above. The `!product?.active` branch has already
  // 404'd when neither did, so this is belt-and-braces — and it narrows
  // `product` for the compiler, which can't see that far back.
  const priceId = premium?.priceId ?? product?.stripe_price_id;
  if (!priceId) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${webUrl}/store/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${webUrl}/store/cancel`,
    client_reference_id: auth.userId,
    metadata: { userId: auth.userId, productId },
  });

  if (!session.url) {
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 },
    );
  }

  const { error: insertError } = await admin.from("store_orders").insert({
    user_id: auth.userId,
    product_id: productId,
    stripe_checkout_session_id: session.id,
    currency_amount: premium ? 0 : (product?.currency_amount ?? 0),
    grant_item_id: premium?.kind === "item" ? productId : null,
    grant_bank_expansions: premium?.kind === "bank-expansion" ? 1 : null,
  });

  if (insertError) {
    return NextResponse.json(
      { error: "Failed to record order" },
      { status: 500 },
    );
  }

  return NextResponse.json({ url: session.url });
}
