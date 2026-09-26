import { bankCapacity, hasRoomFor, normalizeEquipped } from "@herzies/shared";
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

    // Where an item purchase should land. Checkout already refused if the
    // bank was full, but Stripe Checkout can sit open for a long time and the
    // bank may have filled since — and by now the money is taken, so refusing
    // is not an option. An item with nowhere to go drops on the ground
    // instead, where it waits to be collected.
    //
    // Decided here rather than in SQL so the capacity rules stay in the one
    // shared implementation the client and sync loop also use; the RPC just
    // applies the answer atomically. A failed lookup falls through to `false`,
    // which is the pre-existing behaviour for every coin order.
    let toGround = false;
    const { data: order } = await admin
      .from("store_orders")
      .select("user_id, grant_item_id, status")
      .eq("stripe_checkout_session_id", session.id)
      .maybeSingle();

    if (order?.grant_item_id && order.status !== "completed") {
      const { data: herzie } = await admin
        .from("herzies")
        .select("inventory_v2, equipped, bank_expansions")
        .eq("user_id", order.user_id as string)
        .single();

      toGround = !hasRoomFor(
        (herzie?.inventory_v2 ?? {}) as Record<string, number>,
        normalizeEquipped(herzie?.equipped),
        order.grant_item_id as string,
        bankCapacity(herzie?.bank_expansions),
      );
    }

    const { error } = await admin.rpc("fulfill_store_order", {
      p_session_id: session.id,
      p_event_id: event.id,
      p_to_ground: toGround,
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
