import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Stripe webhook receiver. Not authenticated via `authenticateRequest` — the
 * caller is Stripe, not a user, so authenticity comes from the `stripe-signature`
 * header instead. This is the ONLY place currency gets credited for a purchase;
 * the desktop app never reports payment success itself.
 */
export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  // Must read the raw body — signature verification hashes the exact bytes
  // Stripe sent, so this has to happen before any JSON parsing.
  const rawBody = await request.text();

  const stripe = getStripe();
  let event: import("stripe").Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid signature";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data
      .object as import("stripe").Stripe.Checkout.Session;
    const admin = createAdminClient();

    const { error } = await admin.rpc("fulfill_store_order", {
      p_session_id: session.id,
      p_event_id: event.id,
    });

    if (error) {
      // Transient DB failure — ask Stripe to retry.
      return NextResponse.json(
        { error: "Fulfillment failed" },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ received: true });
}
