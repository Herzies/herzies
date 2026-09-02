import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { checkoutSchema, isParseError, parseBody } from "@/lib/schemas";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase-admin";

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

  if (!product?.active) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
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
      product_id: product.id,
      stripe_checkout_session_id: sessionId,
      currency_amount: product.currency_amount,
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

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: product.stripe_price_id, quantity: 1 }],
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
    product_id: product.id,
    stripe_checkout_session_id: session.id,
    currency_amount: product.currency_amount,
  });

  if (insertError) {
    return NextResponse.json(
      { error: "Failed to record order" },
      { status: 500 },
    );
  }

  return NextResponse.json({ url: session.url });
}
