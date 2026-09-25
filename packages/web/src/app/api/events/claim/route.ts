import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { claimEventSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Manual event claim endpoint — for non-automatic events where
 * the user explicitly claims a reward (e.g. completed a challenge).
 *
 * Secret track events are claimed automatically via /api/sync,
 * but this endpoint supports future event types.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, claimEventSchema);
  if (isParseError(body)) return body;

  const { eventId } = body;

  const admin = createAdminClient();

  // Check event exists and is active
  const now = new Date().toISOString();
  const { data: event } = await admin
    .from("events")
    .select("*")
    .eq("id", eventId)
    .eq("active", true)
    .lte("starts_at", now)
    .gte("ends_at", now)
    .single();

  if (!event) {
    return NextResponse.json(
      { error: "Event not found or inactive" },
      { status: 404 },
    );
  }

  // Check if already claimed
  const { data: existingClaim } = await admin
    .from("event_claims")
    .select("id")
    .eq("event_id", eventId)
    .eq("user_id", auth.userId)
    .single();

  if (existingClaim) {
    return NextResponse.json({ error: "Already claimed" }, { status: 409 });
  }

  // Check max claims
  const config = event.config as Record<string, unknown>;
  const maxClaims = (config.maxClaims as number) ?? Infinity;
  const { count } = await admin
    .from("event_claims")
    .select("*", { count: "exact", head: true })
    .eq("event_id", eventId);

  if ((count ?? 0) >= maxClaims) {
    return NextResponse.json({ error: "Event fully claimed" }, { status: 410 });
  }

  // Claim it
  const { error: claimError } = await admin
    .from("event_claims")
    .insert({ event_id: eventId, user_id: auth.userId });

  if (claimError) {
    return NextResponse.json({ error: "Failed to claim" }, { status: 500 });
  }

  // Grant reward item if configured
  const rewardItemId = config.rewardItemId as string | undefined;
  if (rewardItemId) {
    // This used to append to the legacy `herzies.inventory` text[] column,
    // which nothing reads back — a reward granted here never reached the
    // player's bank. Granting through the same RPC every other reward uses
    // makes it a real owned copy. (The claim row above is what stops a repeat.)
    await admin.rpc("grant_inventory_item", {
      p_user_id: auth.userId,
      p_item_id: rewardItemId,
      p_quantity: 1,
    });
  }

  return NextResponse.json({ ok: true, rewardItemId });
}
